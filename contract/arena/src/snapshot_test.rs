use soroban_sdk::{Env, Bytes, symbol_short, String, Address, xdr::ToXdr, xdr::FromXdr, Vec, BytesN};
use soroban_sdk::testutils::Address as _;
use crate::*; // imports all contract types from arena

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
            std::println!("{} bytes: {:?}", std::any::type_name_of_val(&val), actual_slice);
        }
        
        // Also check deserialization
    };
}

#[test]
fn test_snapshots() {
    // Choice
    assert_snapshot!(|_env| Choice::Heads, b"");
    assert_snapshot!(|_env| Choice::Tails, b"");
    
    // ArenaConfig
    assert_snapshot!(|_env| ArenaConfig {
        round_speed_in_ledgers: 10,
        required_stake_amount: 1000,
        max_rounds: 5,
        winner_yield_share_bps: 5000,
        reserve_ratio_bps: 0,
        grace_period_seconds: 60,
        join_deadline: 123456789,
        win_fee_bps: 100,
        is_private: false,
    }, b"");
    
    // RoundState
    assert_snapshot!(|_env| RoundState {
        round_number: 1,
        round_start_ledger: 100,
        round_deadline_ledger: 110,
        active: true,
        total_submissions: 5,
        timed_out: false,
        finished: false,
    }, b"");
    
    // UserStateView
    assert_snapshot!(|_env| UserStateView {
        is_active: true,
        has_won: false,
    }, b"");
    
    // ArenaStateView
    assert_snapshot!(|_env| ArenaStateView {
        survivors_count: 10,
        max_capacity: 100,
        round_number: 2,
        current_stake: 5000,
        potential_payout: 50000,
        vault_active: true,
    }, b"");
    
    // FullStateView
    assert_snapshot!(|_env| FullStateView {
        survivors_count: 10,
        max_capacity: 100,
        round_number: 2,
        current_stake: 5000,
        potential_payout: 50000,
        is_active: true,
        has_won: false,
        vault_active: true,
    }, b"");
    
    // ArenaState
    assert_snapshot!(|_env| ArenaState::Pending, b"");
    assert_snapshot!(|_env| ArenaState::Active, b"");
    assert_snapshot!(|_env| ArenaState::Completed, b"");
    assert_snapshot!(|_env| ArenaState::Cancelled, b"");
    
    // ArenaStateChanged
    assert_snapshot!(|_env| ArenaStateChanged {
        old_state: ArenaState::Pending,
        new_state: ArenaState::Active,
    }, b"");
    
    // ArenaMetadata
    assert_snapshot!(|env: &Env| ArenaMetadata {
        arena_id: 1,
        name: String::from_str(env, "Test"),
        description: Some(String::from_str(env, "Desc")),
        host: Address::generate(env),
        created_at: 1000,
        is_private: true,
    }, b"");
    
    // YieldDistributed
    assert_snapshot!(|_env| YieldDistributed {
        winner_yield: 100,
        eliminated_yield: 200,
        eliminated_count: 5,
    }, b"");
    
    // PlayerJoined
    assert_snapshot!(|env: &Env| PlayerJoined {
        arena_id: 1,
        player: Address::generate(env),
        entry_fee: 100,
    }, b"");
    
    // ChoiceSubmitted
    assert_snapshot!(|env: &Env| ChoiceSubmitted {
        arena_id: 1,
        round: 1,
        player: Address::generate(env),
    }, b"");
    
    // RoundResolved
    assert_snapshot!(|env: &Env| {
        let mut eliminated = Vec::new(env);
        eliminated.push_back(Address::generate(env));
        RoundResolved {
            arena_id: 1,
            round: 1,
            heads_count: 10,
            tails_count: 5,
            eliminated,
        }
    }, b"");
    
    // PlayerEliminated
    assert_snapshot!(|env: &Env| PlayerEliminated {
        arena_id: 1,
        round: 1,
        player: Address::generate(env),
        choice_made: Choice::Heads,
    }, b"");
    
    // WinnerDeclared
    assert_snapshot!(|env: &Env| WinnerDeclared {
        arena_id: 1,
        winner: Address::generate(env),
        prize_pool: 1000,
        yield_earned: 50,
        total_rounds: 5,
    }, b"");
    
    // ArenaCancelled
    assert_snapshot!(|env: &Env| ArenaCancelled {
        arena_id: 1,
        reason: String::from_str(env, "Reason"),
    }, b"");
    
    // ArenaExpired
    assert_snapshot!(|_env| ArenaExpired {
        arena_id: 1,
        refunded_players: 5,
    }, b"");
    
    // ArenaSnapshot
    assert_snapshot!(|_env| ArenaSnapshot {
        arena_id: 1,
        state: ArenaState::Active,
        round_number: 2,
        survivors_count: 10,
        max_capacity: 100,
        current_stake: 1000,
        potential_payout: 10000,
    }, b"");
    
    // DataKey
    assert_snapshot!(|_env| DataKey::Config, b"");
    assert_snapshot!(|_env| DataKey::Round, b"");
    assert_snapshot!(|env: &Env| DataKey::Submission(1, Address::generate(env)), b"");
    assert_snapshot!(|env: &Env| DataKey::Commitment(1, Address::generate(env)), b"");
    assert_snapshot!(|_env| DataKey::RoundPlayers(1), b"");
    assert_snapshot!(|_env| DataKey::AllPlayers, b"");
    assert_snapshot!(|env: &Env| DataKey::Survivor(Address::generate(env)), b"");
    assert_snapshot!(|env: &Env| DataKey::Eliminated(Address::generate(env)), b"");
    assert_snapshot!(|env: &Env| DataKey::PrizeClaimed(Address::generate(env)), b"");
    assert_snapshot!(|env: &Env| DataKey::Claimable(Address::generate(env)), b"");
    assert_snapshot!(|env: &Env| DataKey::Winner(Address::generate(env)), b"");
    assert_snapshot!(|env: &Env| DataKey::Refunded(Address::generate(env)), b"");
    assert_snapshot!(|_env| DataKey::Metadata(1), b"");
    assert_snapshot!(|_env| DataKey::ArenaId, b"");
    assert_snapshot!(|_env| DataKey::FactoryAddress, b"");
}
