use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Env, xdr::FromXdr, xdr::ToXdr};

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
    };
}

#[test]
fn test_snapshots() {
    // DataKey
    assert_snapshot!(
        |env: &Env| DataKey::Position(Address::generate(env)),
        &[
            0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 15, 0, 0, 0, 8, 80, 111, 115, 105, 116,
            105, 111, 110, 0, 0, 0, 18, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
        ]
    );

    // StakePosition
    assert_snapshot!(
        |_env| StakePosition {
            amount: 1000,
            shares: 500,
        },
        &[
            0, 0, 0, 17, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 15, 0, 0, 0, 6, 97, 109, 111, 117, 110,
            116, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 232, 0, 0, 0, 15,
            0, 0, 0, 6, 115, 104, 97, 114, 101, 115, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 1, 244
        ]
    );

    // StakerStats
    assert_snapshot!(
        |_env| StakerStats {
            staked_amount: 1000,
            pending_rewards: 100,
            unlock_at: 123456789,
            total_claimed_rewards: 500,
            stake_share_bps: 1000,
        },
        &[
            0, 0, 0, 17, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 15, 0, 0, 0, 15, 112, 101, 110, 100, 105,
            110, 103, 95, 114, 101, 119, 97, 114, 100, 115, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 15, 0, 0, 0, 15, 115, 116, 97, 107, 101, 95, 115,
            104, 97, 114, 101, 95, 98, 112, 115, 0, 0, 0, 0, 3, 0, 0, 3, 232, 0, 0, 0, 15, 0, 0, 0,
            13, 115, 116, 97, 107, 101, 100, 95, 97, 109, 111, 117, 110, 116, 0, 0, 0, 0, 0, 0, 10,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 232, 0, 0, 0, 15, 0, 0, 0, 21, 116, 111,
            116, 97, 108, 95, 99, 108, 97, 105, 109, 101, 100, 95, 114, 101, 119, 97, 114, 100,
            115, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 244, 0, 0, 0,
            15, 0, 0, 0, 9, 117, 110, 108, 111, 99, 107, 95, 97, 116, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0,
            0, 7, 91, 205, 21
        ]
    );
}
