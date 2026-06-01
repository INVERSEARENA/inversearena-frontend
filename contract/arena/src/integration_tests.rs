#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    Address, BytesN, Env, Symbol, TryFromVal,
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
};
use ::rwa_adapter::{RwaAdapter, RwaAdapterClient};
use ::oracle::{OracleContract, OracleContractClient};

fn compute_commitment(env: &Env, choice: Choice, salt: &BytesN<32>) -> BytesN<32> {
    ArenaContract::compute_commitment(env, choice, salt)
}

#[test]
fn full_game_lifecycle_commit_reveal() {
    let env = Env::default();
    env.mock_all_auths();

    let mut all_events = std::vec::Vec::new();

    // 1. Setup participants
    let admin = Address::generate(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);
    let p4 = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // 2. Deploy and initialize SAC token
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let token_client = token::TokenClient::new(&env, &token_id);
    let token_admin_client = StellarAssetClient::new(&env, &token_id);

    // Mint entry fees (100 each)
    token_admin_client.mint(&p1, &100);
    token_admin_client.mint(&p2, &100);
    token_admin_client.mint(&p3, &100);
    token_admin_client.mint(&p4, &100);

    assert_eq!(token_client.balance(&p1), 100);
    assert_eq!(token_client.balance(&p2), 100);
    assert_eq!(token_client.balance(&p3), 100);
    assert_eq!(token_client.balance(&p4), 100);

    // 3. Deploy and initialize Oracle
    let oracle_id = env.register(OracleContract, ());
    let oracle_client = OracleContractClient::new(&env, &oracle_id);
    oracle_client.initialize(&admin, &500); // 5% yield rate
    all_events.extend(env.events().all().iter());

    // 4. Deploy and initialize RWA Adapter
    let rwa_id = env.register(RwaAdapter, ());
    let rwa_client = RwaAdapterClient::new(&env, &rwa_id);
    rwa_client.initialize(&admin, &token_id);
    all_events.extend(env.events().all().iter());

    // 5. Deploy and initialize Arena Contract
    let arena_id = env.register(ArenaContract, ());
    let arena_client = ArenaContractClient::new(&env, &arena_id);
    arena_client.initialize(&admin, &token_id, &rwa_id, &100, &oracle_id);
    all_events.extend(env.events().all().iter());

    // Verify Arena is in Open state
    assert_eq!(arena_client.player_count(), 0);

    // 6. Players join
    arena_client.join_arena(&p1);
    arena_client.join_arena(&p2);
    arena_client.join_arena(&p3);
    arena_client.join_arena(&p4);
    all_events.extend(env.events().all().iter());

    assert_eq!(arena_client.player_count(), 4);
    assert_eq!(token_client.balance(&p1), 0);
    assert_eq!(token_client.balance(&p2), 0);
    assert_eq!(token_client.balance(&p3), 0);
    assert_eq!(token_client.balance(&p4), 0);
    // Entry fees (400 total) are held by the Arena Contract
    assert_eq!(token_client.balance(&arena_id), 400);

    // 7. Start Round 1
    let start_ts = 1000;
    env.ledger().with_mut(|li| li.timestamp = start_ts);
    arena_client.start_round(&3600); // 1 hour duration
    all_events.extend(env.events().all().iter());

    // 8. Players submit commitments
    let salt_1 = BytesN::from_array(&env, &[1u8; 32]);
    let salt_2 = BytesN::from_array(&env, &[2u8; 32]);
    let salt_3 = BytesN::from_array(&env, &[3u8; 32]);
    let salt_4 = BytesN::from_array(&env, &[4u8; 32]);

    // Player 1 chooses Tails (minority), others choose Heads (majority)
    let c1 = compute_commitment(&env, Choice::Tails, &salt_1);
    let c2 = compute_commitment(&env, Choice::Heads, &salt_2);
    let c3 = compute_commitment(&env, Choice::Heads, &salt_3);
    let c4 = compute_commitment(&env, Choice::Heads, &salt_4);

    arena_client.submit_commitment(&p1, &c1);
    arena_client.submit_commitment(&p2, &c2);
    arena_client.submit_commitment(&p3, &c3);
    arena_client.submit_commitment(&p4, &c4);
    all_events.extend(env.events().all().iter());

    // 9. Advance time past the deadline to allow revealing
    env.ledger().with_mut(|li| li.timestamp = start_ts + 3601);

    // 10. Players reveal choice
    arena_client.reveal_choice(&p1, &Choice::Tails, &salt_1);
    arena_client.reveal_choice(&p2, &Choice::Heads, &salt_2);
    arena_client.reveal_choice(&p3, &Choice::Heads, &salt_3);
    arena_client.reveal_choice(&p4, &Choice::Heads, &salt_4);
    all_events.extend(env.events().all().iter());

    // 11. Resolve Round (eliminates majority, so p2, p3, p4 are eliminated)
    arena_client.resolve_round();
    all_events.extend(env.events().all().iter());

    // Verify player active status
    let players = arena_client.get_players(&0);
    assert_eq!(players.len(), 4);

    let get_player_active = |p: &Address| -> bool {
        players.iter().find(|(addr, _)| addr == p).map(|(_, state)| state.active).unwrap_or(false)
    };

    assert!(get_player_active(&p1), "Player 1 (minority) must survive");
    assert!(!get_player_active(&p2), "Player 2 (majority) must be eliminated");
    assert!(!get_player_active(&p3), "Player 3 (majority) must be eliminated");
    assert!(!get_player_active(&p4), "Player 4 (majority) must be eliminated");

    // 12. Fund RWA adapter with simulated yield + payout
    // Principal (400) + Yield (5% of 400 = 20) = 420.
    // Mint 420 tokens to RWA adapter to satisfy withdraw_all
    token_admin_client.mint(&rwa_id, &420);

    // 13. Winner claims the prize
    arena_client.claim(&p1);
    all_events.extend(env.events().all().iter());

    // 14. Verify final balances
    // Player 1 (winner) gets 420 tokens
    assert_eq!(token_client.balance(&p1), 420);
    // Eliminated players get 0 tokens
    assert_eq!(token_client.balance(&p2), 0);
    assert_eq!(token_client.balance(&p3), 0);
    assert_eq!(token_client.balance(&p4), 0);

    // 15. Verify correct event sequence is emitted
    let has_event = |topic: Symbol| -> bool {
        all_events.iter().any(|e| {
            if let Some(val) = e.1.get(0) {
                if let Ok(symbol) = Symbol::try_from_val(&env, &val) {
                    return symbol == topic;
                }
            }
            false
        })
    };

    assert!(has_event(soroban_sdk::symbol_short!("init")), "Must emit init event");
    assert!(has_event(soroban_sdk::symbol_short!("join")), "Must emit join event");
    assert!(has_event(soroban_sdk::symbol_short!("started")), "Must emit started event");
    assert!(has_event(soroban_sdk::symbol_short!("resolved")), "Must emit resolved event");
    assert!(has_event(soroban_sdk::symbol_short!("elim")), "Must emit elim event");
    assert!(has_event(soroban_sdk::symbol_short!("finished")), "Must emit finished event");
    assert!(has_event(soroban_sdk::symbol_short!("claimed")), "Must emit claimed event");
}
