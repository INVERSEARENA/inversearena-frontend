#![cfg(test)]

extern crate std;

use super::*;
use ::oracle::{OracleContract, OracleContractClient};
use ::rwa_adapter::{RwaAdapter, RwaAdapterClient};
use ::payout::{PayoutContract, PayoutContractClient};
use ::factory::{FactoryContract, FactoryContractClient};
use factory::types::PoolConfig;
use soroban_sdk::{
    Address, BytesN, Env, Symbol, TryFromVal,
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
};

fn compute_commitment(env: &Env, choice: Choice, salt: &BytesN<32>) -> BytesN<32> {
    ArenaContract::compute_commitment(env, choice, salt)
}

#[test]
fn full_game_lifecycle_commit_reveal() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

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
    rwa_client.initialize(&admin, &token_id, &oracle_id);
    all_events.extend(env.events().all().iter());

    // 5. Deploy and initialize Arena Contract
    let arena_id = env.register(ArenaContract, ());
    let arena_client = ArenaContractClient::new(&env, &arena_id);
    arena_client.initialize(
        &admin,
        &token_id,
        &rwa_id,
        &100,
        &oracle_id,
        &Address::generate(&env),
        &1,
        &2,
        &10,
        &60,
    );
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
    // join_arena deposits each entry fee into the vault immediately (per-join,
    // not batched), so the arena itself holds nothing between joins — the
    // vault (rwa_id) receives the full 400 total instead (#1299).
    assert_eq!(token_client.balance(&arena_id), 0);
    assert_eq!(token_client.balance(&rwa_id), 400);

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

    // 11. Advance time by 1 year so vault yield accrues, then resolve the round.
    //     (eliminates majority, so p2, p3, p4 are eliminated)
    env.ledger()
        .with_mut(|li| li.timestamp = start_ts + 31_536_000);
    arena_client.resolve_round();
    all_events.extend(env.events().all().iter());

    // Verify player active status
    let players = arena_client.get_players(&0);
    assert_eq!(players.len(), 4);

    let get_player_active = |p: &Address| -> bool {
        players
            .iter()
            .find(|(addr, _)| addr == p)
            .map(|(_, state)| state.active)
            .unwrap_or(false)
    };

    assert!(get_player_active(&p1), "Player 1 (minority) must survive");
    assert!(
        !get_player_active(&p2),
        "Player 2 (majority) must be eliminated"
    );
    assert!(
        !get_player_active(&p3),
        "Player 3 (majority) must be eliminated"
    );
    assert!(
        !get_player_active(&p4),
        "Player 4 (majority) must be eliminated"
    );

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

    assert!(
        has_event(soroban_sdk::symbol_short!("init")),
        "Must emit init event"
    );
    assert!(
        has_event(soroban_sdk::symbol_short!("join")),
        "Must emit join event"
    );
    assert!(
        has_event(soroban_sdk::symbol_short!("started")),
        "Must emit started event"
    );
    assert!(
        has_event(soroban_sdk::symbol_short!("resolved")),
        "Must emit resolved event"
    );
    assert!(
        has_event(soroban_sdk::symbol_short!("elim")),
        "Must emit elim event"
    );
    assert!(
        has_event(soroban_sdk::symbol_short!("finished")),
        "Must emit finished event"
    );
    assert!(
        has_event(soroban_sdk::symbol_short!("claimed")),
        "Must emit claimed event"
    );
}

/// Full multi-contract integration test: factory → arena → payout (#1147)
///
/// Exercises the six-contract interaction sequence required for a complete
/// InverseArena game lifecycle:
///   1. Factory `create_pool`  → deploys a fresh arena contract
///   2. Players `join_arena`   → deposits to the rwa-adapter vault
///   3. Admin `start_round` → `resolve_round` (oracle provides yield)
///   4. Winner `claim`         → arena withdraws from vault, pays winner
///   5. Admin calls `distribute_winnings` on the payout contract
///
/// This detects cross-contract integration failures (argument mismatches,
/// auth-chain breaks, event sequences) that unit tests cannot catch.
#[test]
fn factory_arena_payout_full_lifecycle() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // ── Participants ───────────────────────────────────────────────────────
    let admin      = Address::generate(&env);
    let host       = Address::generate(&env);
    let token_admin = Address::generate(&env);
    // Three players: p1 picks Tails (minority → survives), p2/p3 pick Heads
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);

    // ── 1. Deploy SAC token and mint entry fees ─────────────────────────
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = token::TokenClient::new(&env, &token_id);
    let token_admin_client = StellarAssetClient::new(&env, &token_id);

    // Each player needs 100 for entry fee; host needs 100 for creator stake.
    token_admin_client.mint(&host, &100);
    token_admin_client.mint(&p1, &100);
    token_admin_client.mint(&p2, &100);
    token_admin_client.mint(&p3, &100);

    // ── 2. Deploy and initialise Oracle ────────────────────────────────
    let oracle_id = env.register(OracleContract, ());
    let oracle_client = OracleContractClient::new(&env, &oracle_id);
    oracle_client.initialize(&admin, &500); // 5% yield (500 bps)

    // ── 3. Deploy and initialise RWA Adapter (vault) ───────────────────
    let rwa_id = env.register(RwaAdapter, ());
    let rwa_client = RwaAdapterClient::new(&env, &rwa_id);
    rwa_client.initialize(&admin, &token_id, &oracle_id);

    // ── 4. Deploy and initialise Payout contract ───────────────────────
    let payout_id = env.register(PayoutContract, ());
    let payout_client = PayoutContractClient::new(&env, &payout_id);
    payout_client.initialize(&admin, &token_id);

    // ── 5. Deploy and initialise Factory ──────────────────────────────
    let factory_id = env.register(FactoryContract, ());
    let factory_client = FactoryContractClient::new(&env, &factory_id);
    factory_client.initialize(&admin, &100);  // min_stake = 100

    // Whitelist host and register approved token/vault/oracle so
    // create_pool does not reject the request.
    factory_client.add_to_whitelist(&host);
    factory_client.add_supported_token(&token_id);
    factory_client.add_approved_vault(&rwa_id);
    factory_client.add_approved_oracle(&oracle_id);

    // Upload arena wasm hash — in the test environment we use the registered
    // wasm hash from ArenaContract directly (crate::WASM within this crate).
    let arena_wasm = env.deployer().upload_contract_wasm(crate::WASM);
    factory_client.set_arena_wasm_hash(&arena_wasm);

    // ── 6. Factory creates pool → returns deployed arena address ───────
    let pool_cfg = PoolConfig {
        stake_token:      token_id.clone(),
        yield_vault:      rwa_id.clone(),
        entry_fee:        100,
        oracle_contract:  oracle_id.clone(),
        min_players:      2,
        max_players:      10,
        round_duration:   3600,
    };
    let arena_addr = factory_client.create_pool(&host, &pool_cfg);
    let arena_client = ArenaContractClient::new(&env, &arena_addr);

    // Factory should have recorded the pool metadata.
    let meta = factory_client.get_arena(&1).unwrap();
    assert_eq!(meta.arena_address, arena_addr);
    assert_eq!(meta.host, host);
    assert_eq!(meta.entry_fee, 100);

    // ── 7. Players join arena (deposits go to the vault via arena) ─────
    arena_client.join_arena(&p1);
    arena_client.join_arena(&p2);
    arena_client.join_arena(&p3);

    assert_eq!(arena_client.player_count(), 3);
    // Entry fees deducted from players
    assert_eq!(token_client.balance(&p1), 0);
    assert_eq!(token_client.balance(&p2), 0);
    assert_eq!(token_client.balance(&p3), 0);
    // join_arena deposits each entry fee into the vault immediately (per-join,
    // not batched), so the arena itself holds nothing between joins — the
    // vault (rwa_id) receives the full 300 total instead (#1299).
    assert_eq!(token_client.balance(&arena_addr), 0);
    assert_eq!(token_client.balance(&rwa_id), 300);

    // ── 8. Admin starts round 1 ────────────────────────────────────────
    let start_ts: u64 = 1_000;
    env.ledger().with_mut(|li| li.timestamp = start_ts);
    arena_client.start_round(&3600);

    // ── 9. Players commit then reveal (p1=Tails minority, p2/p3=Heads) ─
    let salt1 = BytesN::from_array(&env, &[1u8; 32]);
    let salt2 = BytesN::from_array(&env, &[2u8; 32]);
    let salt3 = BytesN::from_array(&env, &[3u8; 32]);

    let c1 = compute_commitment(&env, Choice::Tails, &salt1);
    let c2 = compute_commitment(&env, Choice::Heads, &salt2);
    let c3 = compute_commitment(&env, Choice::Heads, &salt3);

    arena_client.submit_commitment(&p1, &c1);
    arena_client.submit_commitment(&p2, &c2);
    arena_client.submit_commitment(&p3, &c3);

    // Advance past round deadline so reveals are accepted.
    env.ledger().with_mut(|li| li.timestamp = start_ts + 3_601);

    arena_client.reveal_choice(&p1, &Choice::Tails, &salt1);
    arena_client.reveal_choice(&p2, &Choice::Heads, &salt2);
    arena_client.reveal_choice(&p3, &Choice::Heads, &salt3);

    // ── 10. Admin resolves round (oracle provides 5% yield) ────────────
    // Advance time so vault yield accrues.
    env.ledger().with_mut(|li| li.timestamp = start_ts + 31_536_000);
    arena_client.resolve_round();

    // Verify on-chain player states: p1 (minority) survives; p2/p3 eliminated.
    let players = arena_client.get_players(&0);
    for (addr, state) in players.iter() {
        if addr == p1 {
            assert!(state.active, "p1 (minority/Tails) must survive");
            assert_eq!(state.rounds_survived, 1);
        } else {
            assert!(!state.active, "majority voter must be eliminated");
        }
    }

    // Game is now Finished with exactly one survivor.
    let result = arena_client.get_round_result(&1).unwrap();
    assert_eq!(result.eliminated, 2);
    assert_eq!(result.survivors, 1);

    // ── 11. Winner claims prize from arena (arena → vault → winner) ────
    // Simulate vault holding principal (300) + 5% yield (15) = 315.
    token_admin_client.mint(&rwa_id, &315);

    arena_client.claim(&p1);

    // p1 received the full prize pool; p2/p3 get nothing.
    assert!(token_client.balance(&p1) > 0, "winner must receive tokens");
    assert_eq!(token_client.balance(&p2), 0);
    assert_eq!(token_client.balance(&p3), 0);

    // ── 12. Admin distributes payout via payout contract ───────────────
    // Fund the payout contract to cover the winner's on-chain payout record.
    let prize: i128 = 315;
    token_admin_client.mint(&payout_id, &prize);

    // distribute_winnings is idempotent on payout_id; payout_id = 1.
    payout_client.distribute_winnings(&1, &p1, &prize);

    // p1's payout contract balance reflects the distributed amount.
    // (Token balance increases by prize; p2/p3 unchanged.)
    let p1_balance_after = token_client.balance(&p1);
    assert!(p1_balance_after >= prize, "winner balance must include payout contract distribution");

    // Idempotency: a retry of the same payout_id is rejected.
    let retry = payout_client.try_distribute_winnings(&1, &p1, &prize);
    assert!(retry.is_err(), "duplicate payout_id must be rejected");

    // ── 13. Verify get_winner returns the correct address ──────────────
    // (Confirms the on-chain winner matches who we paid.)
    // The arena stores the winner address via set_winner; we can't call it
    // directly, but resolve_round only sets a winner when survivors == 1 and
    // we already verified the round result above.
    assert!(payout_client.is_paid(&1), "payout_id 1 must be marked paid");
}

// ── Regression: expire_arena payout completeness (#1359) ─────────────────────
//
// expire_arena used to transition to Finished and push entry_fee only to players
// still `active`. Eliminated players' stakes then had no way out of the contract:
// `claim` needs a stored_winner that expiry never set, and no sweep existed.
// force_cancel_arena, on the same arena, refunded everyone. These tests pin that
// the two paths now pay out equally.

/// Build an arena with `n` joined players, run one round that eliminates the
/// majority, and return the pieces needed to compare payout paths.
fn arena_after_one_elimination_round(
    env: &Env,
) -> (ArenaContractClient<'static>, token::TokenClient<'static>, Address, std::vec::Vec<Address>) {
    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    let token_client = token::TokenClient::new(env, &token_id);
    let mint = StellarAssetClient::new(env, &token_id);

    // Five players so the round leaves TWO survivors: with one survivor the
    // arena finishes outright and never reopens, which is not the stuck-mid-game
    // situation expire_arena exists for.
    let players: std::vec::Vec<Address> = (0..5).map(|_| Address::generate(env)).collect();
    for p in &players {
        mint.mint(p, &100);
    }

    let oracle_id = env.register(OracleContract, ());
    OracleContractClient::new(env, &oracle_id).initialize(&admin, &0);

    let rwa_id = env.register(RwaAdapter, ());
    RwaAdapterClient::new(env, &rwa_id).initialize(&admin, &token_id, &oracle_id);

    let arena_id = env.register(ArenaContract, ());
    let arena_client = ArenaContractClient::new(env, &arena_id);
    arena_client.initialize(
        &admin,
        &token_id,
        &rwa_id,
        &100,
        &oracle_id,
        &Address::generate(env),
        &1,
        &2,
        &10,
        &60,
    );

    for p in &players {
        arena_client.join_arena(p);
    }

    // One round: players 0 and 1 pick the minority and survive; the other three
    // are eliminated, so the arena returns to Open with more than one survivor.
    env.ledger().with_mut(|li| li.timestamp = 1000);
    arena_client.start_round(&3600);

    let salts: std::vec::Vec<BytesN<32>> = (0..5)
        .map(|i| BytesN::from_array(env, &[i as u8 + 1; 32]))
        .collect();
    let choices = [
        Choice::Tails,
        Choice::Tails,
        Choice::Heads,
        Choice::Heads,
        Choice::Heads,
    ];

    for i in 0..5 {
        arena_client.submit_commitment(&players[i], &compute_commitment(env, choices[i], &salts[i]));
    }
    env.ledger().with_mut(|li| li.timestamp = 1000 + 3601);
    for i in 0..5 {
        arena_client.reveal_choice(&players[i], &choices[i], &salts[i]);
    }
    arena_client.resolve_round();

    (arena_client, token_client, arena_id, players)
}

#[test]
fn expire_arena_lets_every_joined_player_reclaim_their_stake() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (arena_client, token_client, _arena_id, players) = arena_after_one_elimination_round(&env);

    // Another round is under way and nobody resolves it — the arena is stuck.
    arena_client.start_round(&3600);
    env.ledger().with_mut(|li| li.timestamp = 1000 + 3601 + 3601);
    arena_client.expire_arena();

    for p in &players {
        assert!(
            arena_client.try_claim_refund(p).is_ok(),
            "every joined player must be refundable after expiry, eliminated or not",
        );
        assert_eq!(
            token_client.balance(p),
            100,
            "each player should have their entry fee back",
        );
    }
}

#[test]
fn expire_arena_and_force_cancel_arena_pay_out_identically() {
    // Expiry path.
    let expire_env = Env::default();
    expire_env.mock_all_auths_allowing_non_root_auth();
    let (expire_client, expire_token, _, expire_players) =
        arena_after_one_elimination_round(&expire_env);
    expire_client.start_round(&3600);
    expire_env.ledger().with_mut(|li| li.timestamp = 1000 + 3601 + 3601);
    expire_client.expire_arena();
    for p in &expire_players {
        let _ = expire_client.try_claim_refund(p);
    }
    let expired_balances: std::vec::Vec<i128> =
        expire_players.iter().map(|p| expire_token.balance(p)).collect();

    // Force-cancel path, same shape of arena.
    let cancel_env = Env::default();
    cancel_env.mock_all_auths_allowing_non_root_auth();
    let (cancel_client, cancel_token, _, cancel_players) =
        arena_after_one_elimination_round(&cancel_env);
    cancel_client.force_cancel_arena();
    for p in &cancel_players {
        let _ = cancel_client.try_claim_refund(p);
    }
    let cancelled_balances: std::vec::Vec<i128> =
        cancel_players.iter().map(|p| cancel_token.balance(p)).collect();

    assert_eq!(
        expired_balances, cancelled_balances,
        "expiry must pay out exactly as force-cancel does",
    );
}

#[test]
fn expire_arena_does_not_strand_eliminated_players_principal() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (arena_client, token_client, arena_id, players) = arena_after_one_elimination_round(&env);

    arena_client.start_round(&3600);
    env.ledger().with_mut(|li| li.timestamp = 1000 + 3601 + 3601);
    arena_client.expire_arena();

    for p in &players {
        let _ = arena_client.try_claim_refund(p);
    }

    // Every player's principal (5 × 100) has left the contract. Anything still
    // held is accrued yield, which force_cancel_arena leaves behind too.
    let residual = token_client.balance(&arena_id);
    assert!(
        residual < 500,
        "eliminated players' principal must not remain stranded (residual: {residual})",
    );
}
