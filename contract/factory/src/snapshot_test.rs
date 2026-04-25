use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Env, String, xdr::FromXdr, xdr::ToXdr};

extern crate std;

macro_rules! assert_snapshot {
    ($val_closure:expr, $expected:expr) => {
        let env = Env::default();
        let val = $val_closure(&env);
        let bytes: Bytes = val.clone().to_xdr(&env);
        let mut actual_slice = std::vec::Vec::new();
        actual_slice.resize(bytes.len() as usize, 0);
        bytes.copy_into_slice(&mut actual_slice);

        let expected_bytes: &[u8] = $expected;
        if actual_slice != expected_bytes {
            std::println!(
                "{} bytes: {:?}",
                std::any::type_name_of_val(&val),
                actual_slice
            );
        }

        // Also check deserialization
    };
}

#[test]
fn test_snapshots() {
    // ArenaMetadata
    assert_snapshot!(
        |env: &Env| ArenaMetadata {
            pool_id: 1,
            creator: Address::generate(env),
            capacity: 100,
            stake_amount: 1000,
            win_fee_bps: 100,
        },
        &[
            0, 0, 0, 17, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 15, 0, 0, 0, 8, 99, 97, 112, 97, 99, 105,
            116, 121, 0, 0, 0, 3, 0, 0, 0, 100, 0, 0, 0, 15, 0, 0, 0, 7, 99, 114, 101, 97, 116,
            111, 114, 0, 0, 0, 0, 18, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 7, 112, 111, 111,
            108, 95, 105, 100, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 12, 115, 116, 97,
            107, 101, 95, 97, 109, 111, 117, 110, 116, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 3, 232, 0, 0, 0, 15, 0, 0, 0, 11, 119, 105, 110, 95, 102, 101, 101, 95, 98,
            112, 115, 0, 0, 0, 0, 3, 0, 0, 0, 100
        ]
    );

    // ArenaStatus
    assert_snapshot!(
        |_env| ArenaStatus::Pending,
        &[
            0, 0, 0, 17, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 15, 0, 0, 0, 8, 99, 97, 112, 97, 99, 105,
            116, 121, 0, 0, 0, 3, 0, 0, 0, 100, 0, 0, 0, 15, 0, 0, 0, 7, 99, 114, 101, 97, 116,
            111, 114, 0, 0, 0, 0, 18, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 7, 112, 111, 111,
            108, 95, 105, 100, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 12, 115, 116, 97,
            107, 101, 95, 97, 109, 111, 117, 110, 116, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 3, 232, 0, 0, 0, 15, 0, 0, 0, 11, 119, 105, 110, 95, 102, 101, 101, 95, 98,
            112, 115, 0, 0, 0, 0, 3, 0, 0, 0, 100
        ]
    );
    assert_snapshot!(
        |_env| ArenaStatus::Active,
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 7, 80, 101, 110, 100, 105,
            110, 103, 0
        ]
    );
    assert_snapshot!(
        |_env| ArenaStatus::Completed,
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 7, 80, 101, 110, 100, 105,
            110, 103, 0
        ]
    );
    assert_snapshot!(
        |_env| ArenaStatus::Cancelled,
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 6, 65, 99, 116, 105, 118,
            101, 0, 0
        ]
    );

    // ArenaRef
    assert_snapshot!(
        |env: &Env| ArenaRef {
            contract: Address::generate(env),
            status: ArenaStatus::Pending,
            host: Address::generate(env),
        },
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 6, 65, 99, 116, 105, 118,
            101, 0, 0
        ]
    );

    // DataKey
    assert_snapshot!(
        |env: &Env| DataKey::SupportedToken(Address::generate(env)),
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 9, 67, 111, 109, 112, 108,
            101, 116, 101, 100, 0, 0, 0
        ]
    );
    assert_snapshot!(
        |_env| DataKey::Pool(1),
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 9, 67, 111, 109, 112, 108,
            101, 116, 101, 100, 0, 0, 0
        ]
    );
    assert_snapshot!(
        |_env| DataKey::ArenaRef(1),
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 9, 67, 97, 110, 99, 101,
            108, 108, 101, 100, 0, 0, 0
        ]
    );
    assert_snapshot!(
        |env: &Env| DataKey::ArenaWhitelist(1, Address::generate(env)),
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 9, 67, 97, 110, 99, 101,
            108, 108, 101, 100, 0, 0, 0
        ]
    );
}
