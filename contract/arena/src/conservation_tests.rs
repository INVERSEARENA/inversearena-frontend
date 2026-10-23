//! Stateful property test: cross-contract token conservation (#1633).
//!
//! Existing proptests cover elimination maths and state transitions in
//! isolation. This harness drives random sequences of every fund-moving entry
//! point across several arenas that share one yield vault, deployed by a real
//! factory, and checks the protocol's financial invariants after **every**
//! step:
//!
//! - **Conservation** — every token minted (entry-fee funds, creator stakes,
//!   yield funding) is held by a known participant: players, hosts, the
//!   arenas, the vault or the factory. Nothing leaks to an unknown address and
//!   nothing appears from nowhere.
//! - **No negative balances.**
//! - **Each player paid at most once per entry** — for every (arena, player),
//!   the number of payouts never exceeds the number of joins.
//! - **Refunds are exact** — a refund (leave, ban, cancelled-arena claim)
//!   returns exactly the entry fee.
//! - **Creator stake returned at most once**, and exactly the amount staked.
//!
//! After the sequence a deterministic drain drives every arena to a terminal
//! state and makes every claim, then checks the per-player no-loss property
//! (nobody loses money in a cancelled arena) and that no principal is
//! stranded: once everything is claimed, the factory holds nothing and the
//! arenas plus vault hold at most the yield that was funded.
//!
//! Sequences shrink to a minimal failing one; failures are recorded in
//! `proptest-regressions/conservation_tests.txt` and replayed first on every
//! run. CI runs a bounded number of cases; the nightly workflow raises it
//! with `PROPTEST_CASES`.
//!
//! Authorization is not under test here (see `auth_tests.rs`), so the harness
//! uses `mock_all_auths` — root authorizations only, so the arena's own
//! pre-authorization of the vault's fee pull is still exercised. This file is
//! on `scripts/mock-all-auths-allowlist.txt`.

#![cfg(test)]

extern crate std;

use crate::types::Choice;
use crate::{ArenaContract, ArenaContractClient};
use ::factory::types::PoolConfig;
use ::factory::{FactoryContract, FactoryContractClient};
use ::oracle::{OracleContract, OracleContractClient};
use ::rwa_adapter::{RwaAdapter, RwaAdapterClient};
use proptest::prelude::*;
use soroban_sdk::{
    Address, BytesN, Env, Symbol,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
};
use std::collections::BTreeMap;
use std::vec;
use std::vec::Vec;

const ARENAS: usize = 2;
const PLAYERS: usize = 4;
const FEE: i128 = 1_000;
const ROUND: u64 = 60;
/// Each player can afford to join every arena several times over.
const PLAYER_FUNDS: i128 = FEE * 20;

#[derive(Clone, Copy, Debug)]
enum Action {
    Join { arena: usize, player: usize },
    Leave { arena: usize, player: usize },
    Ban { arena: usize, player: usize },
    StartRound { arena: usize },
    Commit { arena: usize, player: usize, tails: bool },
    Reveal { arena: usize, player: usize },
    Resolve { arena: usize },
    Cancel { arena: usize },
    ForceCancel { arena: usize },
    CancelUnstarted { arena: usize },
    Expire { arena: usize },
    Claim { arena: usize, player: usize },
    ClaimRefund { arena: usize, player: usize },
    Advance { seconds: u64 },
    FundYield { amount: i128 },
    Pause { arena: usize },
    Unpause { arena: usize },
    GlobalPause { paused: bool },
}

fn action() -> impl Strategy<Value = Action> {
    let arena = 0..ARENAS;
    let player = 0..PLAYERS;
    prop_oneof![
        // Joins, commits and reveals are what move games forward, so they are
        // drawn more often than the exits.
        4 => (arena.clone(), player.clone()).prop_map(|(arena, player)| Action::Join { arena, player }),
        3 => (arena.clone(), player.clone(), any::<bool>())
            .prop_map(|(arena, player, tails)| Action::Commit { arena, player, tails }),
        3 => (arena.clone(), player.clone()).prop_map(|(arena, player)| Action::Reveal { arena, player }),
        2 => arena.clone().prop_map(|arena| Action::StartRound { arena }),
        2 => arena.clone().prop_map(|arena| Action::Resolve { arena }),
        2 => (arena.clone(), player.clone()).prop_map(|(arena, player)| Action::Claim { arena, player }),
        2 => (arena.clone(), player.clone())
            .prop_map(|(arena, player)| Action::ClaimRefund { arena, player }),
        1 => (arena.clone(), player.clone()).prop_map(|(arena, player)| Action::Leave { arena, player }),
        1 => (arena.clone(), player.clone()).prop_map(|(arena, player)| Action::Ban { arena, player }),
        1 => arena.clone().prop_map(|arena| Action::Cancel { arena }),
        1 => arena.clone().prop_map(|arena| Action::ForceCancel { arena }),
        1 => arena.clone().prop_map(|arena| Action::CancelUnstarted { arena }),
        1 => arena.clone().prop_map(|arena| Action::Expire { arena }),
        2 => prop::sample::select(&[ROUND, ROUND + 1, 3_600, 86_400][..])
            .prop_map(|seconds| Action::Advance { seconds }),
        1 => (1i128..=500).prop_map(|amount| Action::FundYield { amount }),
        1 => arena.clone().prop_map(|arena| Action::Pause { arena }),
        1 => arena.prop_map(|arena| Action::Unpause { arena }),
        1 => any::<bool>().prop_map(|paused| Action::GlobalPause { paused }),
    ]
}

/// The deployed system plus the harness's own bookkeeping.
struct World {
    env: Env,
    token: TokenClient<'static>,
    minter: StellarAssetClient<'static>,
    factory: FactoryContractClient<'static>,
    oracle: OracleContractClient<'static>,
    vault: RwaAdapterClient<'static>,
    arenas: Vec<ArenaContractClient<'static>>,
    hosts: Vec<Address>,
    players: Vec<Address>,
    yield_bps: u32,

    /// Every token ever minted, by purpose.
    minted: i128,
    yield_funded: i128,
    /// Per (arena, player): successful joins and payouts received.
    joins: BTreeMap<(usize, usize), u32>,
    payouts: BTreeMap<(usize, usize), u32>,
    /// Per arena: creator stake returns observed.
    stake_returns: [u32; ARENAS],
    /// Per (arena, player): net tokens moved (received − paid).
    net: BTreeMap<(usize, usize), i128>,
    /// Last commitment per (arena, player), for the matching reveal.
    commitments: BTreeMap<(usize, usize), (Choice, BytesN<32>)>,
    salt_counter: u8,
}

impl World {
    fn new(yield_bps: u32) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();

        let protocol_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let token = TokenClient::new(&env, &token_id);
        let minter = StellarAssetClient::new(&env, &token_id);

        let oracle = OracleContractClient::new(&env, &env.register(OracleContract, ()));
        oracle.initialize(&protocol_admin, &yield_bps);
        let vault = RwaAdapterClient::new(&env, &env.register(RwaAdapter, ()));
        vault.initialize(&protocol_admin, &token_id, &oracle.address);

        let factory = FactoryContractClient::new(&env, &env.register(FactoryContract, ()));
        factory.initialize(&protocol_admin, &1);
        factory.add_supported_token(&token_id);
        factory.add_approved_vault(&vault.address);
        factory.add_approved_oracle(&oracle.address);
        factory.set_arena_wasm_hash(&env.deployer().upload_contract_wasm(crate::WASM));

        let mut world = World {
            token,
            minter,
            factory,
            oracle,
            vault,
            arenas: Vec::new(),
            hosts: Vec::new(),
            players: Vec::new(),
            yield_bps,
            minted: 0,
            yield_funded: 0,
            joins: BTreeMap::new(),
            payouts: BTreeMap::new(),
            stake_returns: [0; ARENAS],
            net: BTreeMap::new(),
            commitments: BTreeMap::new(),
            salt_counter: 0,
            env,
        };

        for _ in 0..ARENAS {
            let host = Address::generate(&world.env);
            world.factory.add_to_whitelist(&host);
            world.mint(&host, FEE);
            let config = PoolConfig {
                stake_token: token_id.clone(),
                yield_vault: world.vault.address.clone(),
                entry_fee: FEE,
                oracle_contract: world.oracle.address.clone(),
                min_players: 2,
                max_players: PLAYERS as u32,
                round_duration: ROUND,
                start_deadline: world.env.ledger().timestamp() + 86_400,
            };
            let arena = world
                .factory
                .create_pool(&host, &config, &BytesN::from_array(&world.env, &[1u8; 32]));
            world.arenas.push(ArenaContractClient::new(&world.env, &arena));
            world.hosts.push(host);
        }
        for _ in 0..PLAYERS {
            let player = Address::generate(&world.env);
            world.mint(&player, PLAYER_FUNDS);
            world.players.push(player);
        }
        world
    }

    fn mint(&mut self, to: &Address, amount: i128) {
        self.minter.mint(to, &amount);
        self.minted += amount;
    }

    fn system(&self) -> Vec<Address> {
        let mut holders: Vec<Address> = self.arenas.iter().map(|a| a.address.clone()).collect();
        holders.push(self.vault.address.clone());
        holders.push(self.factory.address.clone());
        holders
    }

    fn balance(&self, who: &Address) -> i128 {
        self.token.balance(who)
    }

    fn player_balances(&self) -> Vec<i128> {
        self.players.iter().map(|p| self.balance(p)).collect()
    }

    fn host_balances(&self) -> Vec<i128> {
        self.hosts.iter().map(|h| self.balance(h)).collect()
    }

    /// Keep the shared vault able to pay every position (#1633): RWA yield
    /// is funded from outside the protocol, so the harness funds whatever the
    /// positions have accrued beyond the vault's balance and counts it as
    /// yield funding.
    fn fund_accrued_yield(&mut self) {
        let owed: i128 = self.arenas.iter().map(|a| self.vault.balance_of(&a.address)).sum();
        let held = self.balance(&self.vault.address);
        if owed > held {
            let shortfall = owed - held;
            let vault = self.vault.address.clone();
            self.mint(&vault, shortfall);
            self.yield_funded += shortfall;
        }
    }

    fn refresh_oracle(&self) {
        self.oracle.set_yield_bps(&self.yield_bps);
    }

    fn next_salt(&mut self) -> BytesN<32> {
        self.salt_counter = self.salt_counter.wrapping_add(1);
        BytesN::from_array(&self.env, &[self.salt_counter; 32])
    }

    /// Run one action. Failures are expected and fine — they must revert
    /// without moving anything, which the invariants check.
    fn apply(&mut self, action: Action) {
        let players_before = self.player_balances();
        let hosts_before = self.host_balances();
        let (arena_of_step, _succeeded) = self.execute(action);

        // Attribute every balance change to the arena the step acted on.
        let players_after = self.player_balances();
        for p in 0..PLAYERS {
            let delta = players_after[p] - players_before[p];
            if delta == 0 {
                continue;
            }
            let arena = arena_of_step.unwrap_or_else(|| {
                panic!("{action:?} moved player {p}'s balance by {delta} without acting on an arena")
            });
            *self.net.entry((arena, p)).or_default() += delta;
            if delta < 0 {
                assert!(
                    matches!(action, Action::Join { player, .. } if player == p),
                    "{action:?} took {delta} from player {p}"
                );
                assert_eq!(delta, -FEE, "a join must cost exactly the entry fee");
                *self.joins.entry((arena, p)).or_default() += 1;
            } else {
                let paid = self.payouts.entry((arena, p)).or_default();
                *paid += 1;
                let joined = self.joins.get(&(arena, p)).copied().unwrap_or(0);
                assert!(
                    *paid <= joined,
                    "player {p} was paid {paid} times by arena {arena} after joining {joined} times ({action:?})"
                );
                if !matches!(action, Action::Claim { .. }) {
                    assert_eq!(delta, FEE, "{action:?}: a refund must return exactly the entry fee");
                }
            }
        }
        let hosts_after = self.host_balances();
        for h in 0..ARENAS {
            let delta = hosts_after[h] - hosts_before[h];
            if delta == 0 {
                continue;
            }
            assert_eq!(delta, FEE, "{action:?}: host {h}'s stake must return in full");
            self.stake_returns[h] += 1;
            assert!(self.stake_returns[h] <= 1, "host {h}'s creator stake was returned twice");
        }
        self.check_conservation(&std::format!("after {action:?}"));
    }

    /// Returns the arena the action targeted (if any) and whether it succeeded.
    fn execute(&mut self, action: Action) -> (Option<usize>, bool) {
        let ok = match action {
            Action::Join { arena, player } => {
                self.arenas[arena].try_join_arena(&self.players[player]).is_ok()
            }
            Action::Leave { arena, player } => {
                self.arenas[arena].try_leave_arena(&self.players[player]).is_ok()
            }
            Action::Ban { arena, player } => {
                self.arenas[arena].try_ban_player(&self.players[player]).is_ok()
            }
            Action::StartRound { arena } => self.arenas[arena].try_start_round(&ROUND).is_ok(),
            Action::Commit { arena, player, tails } => {
                let choice = if tails { Choice::Tails } else { Choice::Heads };
                let salt = self.next_salt();
                let commitment = ArenaContract::compute_commitment(
                    &self.env,
                    &self.arenas[arena].address,
                    1,
                    &self.players[player],
                    choice,
                    &salt,
                );
                let ok = self.arenas[arena]
                    .try_submit_commitment(&self.players[player], &commitment)
                    .is_ok();
                if ok {
                    self.commitments.insert((arena, player), (choice, salt));
                }
                ok
            }
            Action::Reveal { arena, player } => match self.commitments.get(&(arena, player)) {
                Some((choice, salt)) => self.arenas[arena]
                    .try_reveal_choice(&self.players[player], choice, salt)
                    .is_ok(),
                None => false,
            },
            Action::Resolve { arena } => {
                self.refresh_oracle();
                self.arenas[arena].try_resolve_round().is_ok()
            }
            Action::Cancel { arena } => self.arenas[arena].try_cancel_arena().is_ok(),
            Action::ForceCancel { arena } => self.arenas[arena].try_force_cancel_arena().is_ok(),
            Action::CancelUnstarted { arena } => self.arenas[arena].try_cancel_unstarted().is_ok(),
            Action::Expire { arena } => self.arenas[arena].try_expire_arena().is_ok(),
            Action::Claim { arena, player } => {
                self.arenas[arena].try_claim(&self.players[player]).is_ok()
            }
            Action::ClaimRefund { arena, player } => {
                self.arenas[arena].try_claim_refund(&self.players[player]).is_ok()
            }
            Action::Advance { seconds } => {
                self.env.ledger().with_mut(|li| li.timestamp += seconds);
                self.fund_accrued_yield();
                return (None, true);
            }
            Action::FundYield { amount } => {
                let vault = self.vault.address.clone();
                self.mint(&vault, amount);
                self.yield_funded += amount;
                return (None, true);
            }
            Action::Pause { arena } => {
                self.arenas[arena].try_pause(&Symbol::new(&self.env, "test")).is_ok()
            }
            Action::Unpause { arena } => self.arenas[arena].try_unpause().is_ok(),
            Action::GlobalPause { paused } => {
                let _ = self
                    .factory
                    .try_set_global_pause(&paused, &Symbol::new(&self.env, "test"));
                return (None, true);
            }
        };
        let arena = match action {
            Action::Join { arena, .. }
            | Action::Leave { arena, .. }
            | Action::Ban { arena, .. }
            | Action::StartRound { arena }
            | Action::Commit { arena, .. }
            | Action::Reveal { arena, .. }
            | Action::Resolve { arena }
            | Action::Cancel { arena }
            | Action::ForceCancel { arena }
            | Action::CancelUnstarted { arena }
            | Action::Expire { arena }
            | Action::Claim { arena, .. }
            | Action::ClaimRefund { arena, .. }
            | Action::Pause { arena }
            | Action::Unpause { arena } => Some(arena),
            _ => None,
        };
        (arena, ok)
    }

    fn check_conservation(&self, context: &str) {
        let mut held: i128 = 0;
        for who in self
            .players
            .iter()
            .chain(self.hosts.iter())
            .cloned()
            .chain(self.system())
        {
            let balance = self.balance(&who);
            assert!(balance >= 0, "negative balance {context}");
            held += balance;
        }
        assert_eq!(
            held, self.minted,
            "conservation broken {context}: {} minted but {} held by known participants",
            self.minted, held
        );
    }

    /// Drive every arena to a terminal state and make every claim, then check
    /// the end-of-life invariants.
    fn drain_and_check(&mut self) {
        self.apply(Action::GlobalPause { paused: false });
        for a in 0..ARENAS {
            self.apply(Action::Unpause { arena: a });
            // Anything not finished with a winner is cancelled so its players
            // can be refunded (a finished arena refuses this).
            self.apply(Action::ForceCancel { arena: a });
        }
        self.fund_accrued_yield();
        for a in 0..ARENAS {
            for p in 0..PLAYERS {
                self.apply(Action::Claim { arena: a, player: p });
                self.apply(Action::ClaimRefund { arena: a, player: p });
            }
        }
        self.check_conservation("after the drain");

        for a in 0..ARENAS {
            let finished = self.arenas[a].get_settlement().finished;
            for p in 0..PLAYERS {
                let net = self.net.get(&(a, p)).copied().unwrap_or(0);
                if finished {
                    // Losers forfeit at most their one entry; the winner never
                    // nets a loss.
                    assert!(net >= -FEE, "player {p} lost {net} in finished arena {a}");
                } else {
                    assert_eq!(net, 0, "player {p} lost {net} in cancelled arena {a}");
                }
            }
            assert_eq!(self.stake_returns[a], 1, "host {a}'s creator stake must come back once");
        }

        assert_eq!(
            self.balance(&self.factory.address),
            0,
            "the factory must not keep any creator stake"
        );
        let stranded: i128 = self.system().iter().map(|who| self.balance(who)).sum();
        assert!(
            stranded <= self.yield_funded,
            "principal stranded: {stranded} left in the system but only {} of yield was funded",
            self.yield_funded
        );
    }
}

fn run(yield_bps: u32, actions: &[Action]) {
    let mut world = World::new(yield_bps);
    world.check_conservation("after setup");
    for action in actions {
        world.apply(*action);
    }
    world.drain_and_check();
}

proptest! {
    // A bounded count keeps PR CI fast; the nightly job raises it through the
    // PROPTEST_CASES environment variable, which proptest reads itself.
    #![proptest_config(ProptestConfig {
        cases: 24,
        max_shrink_iters: 2_048,
        ..ProptestConfig::default()
    })]

    /// Zero-yield vault: every invariant must hold to the unit.
    #[test]
    fn conservation_holds_without_yield(actions in prop::collection::vec(action(), 1..60)) {
        run(0, &actions);
    }

    /// 5% yield with time advancement: accrual, funding and rounding in play.
    #[test]
    fn conservation_holds_with_yield(actions in prop::collection::vec(action(), 1..60)) {
        run(500, &actions);
    }
}

// ── Committed regression sequences ───────────────────────────────────────────
//
// Fixed sequences for the bug classes this harness exists for, so they run on
// every build regardless of what the random search happens to draw.

/// Two refund attempts for the same player in a cancelled arena.
#[test]
fn regression_double_refund_is_refused() {
    use Action::*;
    run(
        0,
        &[
            Join { arena: 0, player: 0 },
            Join { arena: 0, player: 1 },
            Cancel { arena: 0 },
            ClaimRefund { arena: 0, player: 0 },
            ClaimRefund { arena: 0, player: 0 },
        ],
    );
}

/// Leave and rejoin, then cancel: the player is refunded once per entry.
#[test]
fn regression_leave_rejoin_then_cancel() {
    use Action::*;
    run(
        0,
        &[
            Join { arena: 1, player: 2 },
            Leave { arena: 1, player: 2 },
            Join { arena: 1, player: 2 },
            Join { arena: 1, player: 3 },
            Cancel { arena: 1 },
            ClaimRefund { arena: 1, player: 2 },
            ClaimRefund { arena: 1, player: 3 },
        ],
    );
}

/// A full game in one arena while the other is cancelled with yield accruing
/// on the shared vault, so one arena's withdrawal cannot eat the other's.
#[test]
fn regression_shared_vault_finish_and_cancel_with_yield() {
    use Action::*;
    run(
        500,
        &[
            Join { arena: 0, player: 0 },
            Join { arena: 0, player: 1 },
            Join { arena: 0, player: 2 },
            Join { arena: 1, player: 0 },
            Join { arena: 1, player: 3 },
            StartRound { arena: 0 },
            Commit { arena: 0, player: 0, tails: true },
            Commit { arena: 0, player: 1, tails: false },
            Commit { arena: 0, player: 2, tails: false },
            Advance { seconds: 3_600 },
            Reveal { arena: 0, player: 0 },
            Reveal { arena: 0, player: 1 },
            Reveal { arena: 0, player: 2 },
            Resolve { arena: 0 },
            Advance { seconds: 3_600 },
            Cancel { arena: 1 },
            Claim { arena: 0, player: 0 },
            ClaimRefund { arena: 1, player: 0 },
            ClaimRefund { arena: 1, player: 3 },
        ],
    );
}

/// Every exit while paused is refused without moving funds, then works once
/// the pauses lift.
#[test]
fn regression_paused_states_hold_funds() {
    use Action::*;
    run(
        0,
        &[
            Join { arena: 0, player: 0 },
            Join { arena: 0, player: 1 },
            GlobalPause { paused: true },
            Cancel { arena: 0 },
            ForceCancel { arena: 0 },
            Leave { arena: 0, player: 0 },
            GlobalPause { paused: false },
            Pause { arena: 0 },
            Leave { arena: 0, player: 0 },
            ClaimRefund { arena: 0, player: 1 },
            Unpause { arena: 0 },
            Cancel { arena: 0 },
        ],
    );
}

/// The lobby deadline passes and anyone cancels the unstarted arena.
#[test]
fn regression_cancel_unstarted_after_deadline() {
    use Action::*;
    run(
        0,
        &[
            Join { arena: 0, player: 0 },
            Advance { seconds: 86_400 },
            Join { arena: 0, player: 1 },
            CancelUnstarted { arena: 0 },
            ClaimRefund { arena: 0, player: 0 },
        ],
    );
}
