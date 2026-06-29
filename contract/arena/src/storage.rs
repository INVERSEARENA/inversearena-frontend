use crate::types::{
    ArenaConfig, ArenaError, Choice, GameState, PendingAdmin, PlayerState, RoundResult,
    YieldSnapshot,
};
use soroban_sdk::{Address, BytesN, Env, IntoVal, Val, Vec, contracttype, symbol_short};
use crate::types::PendingUpgrade;

const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1000;

/// Storage key for per-player data, keyed by the player's address.
#[contracttype]
enum DataKey {
    Player(Address),
    BannedPlayer(Address),
    CommitmentForRound(Address, u32),
    ChoiceForRound(Address, u32),
    YieldSnapshot(u32),
    RoundResult(u32),
    RoundYieldBps(u32),
    RoundStart,
    RoundDuration,
    LastVaultBalance,
    PrizeClaimed,
    MinPlayers,
    MaxPlayers,
    ReentrancyGuard,
    CreatorActivePools(Address),
    Winner,
    RefundClaimed(Address),
    Leaderboard,
    LeaderboardLimit,
}

pub struct ArenaStorage;

impl ArenaStorage {
    fn extend_persistent_ttl<K>(env: &Env, key: &K)
    where
        K: IntoVal<Env, Val>,
    {
        if env.storage().persistent().has(key) {
            env.storage().persistent().extend_ttl(
                key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND_TO,
            );
        }
    }

    pub fn load_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
        Self::extend_persistent_ttl(env, &symbol_short!("CONFIG"));
        env.storage()
            .persistent()
            .get(&symbol_short!("CONFIG"))
            .ok_or(ArenaError::NotInitialized)
    }

    pub fn save_config(env: &Env, config: &ArenaConfig) {
        Self::extend_persistent_ttl(env, &symbol_short!("CONFIG"));
        env.storage()
            .persistent()
            .set(&symbol_short!("CONFIG"), config);
    }

    pub fn has_config(env: &Env) -> bool {
        Self::extend_persistent_ttl(env, &symbol_short!("CONFIG"));
        env.storage().persistent().has(&symbol_short!("CONFIG"))
    }

    /// Return the list of all player addresses that have joined this arena.
    pub fn load_all_players(env: &Env) -> Vec<Address> {
        Self::extend_persistent_ttl(env, &symbol_short!("PLAYERS"));
        env.storage()
            .persistent()
            .get(&symbol_short!("PLAYERS"))
            .unwrap_or_else(|| Vec::new(env))
    }

    pub fn save_players(env: &Env, players: &Vec<Address>) {
        Self::extend_persistent_ttl(env, &symbol_short!("PLAYERS"));
        env.storage()
            .persistent()
            .set(&symbol_short!("PLAYERS"), players);
    }

    pub fn add_player(env: &Env, player: &Address) {
        let mut players = Self::load_all_players(env);
        players.push_back(player.clone());
        Self::save_players(env, &players);

        // Initialise the joining player's state (active, no rounds survived yet).
        Self::save_player(
            env,
            player,
            &PlayerState {
                active: true,
                rounds_survived: 0,
            },
        );

        // Keep the cached player count in `config` in sync so `player_count`
        // can be served without scanning the players list.
        if let Ok(mut config) = Self::load_config(env) {
            config.player_count = players.len();
            Self::save_config(env, &config);
        }
    }

    /// Load a single player's state, or `None` if they never joined.
    pub fn load_player(env: &Env, player: &Address) -> Option<PlayerState> {
        Self::extend_persistent_ttl(env, &DataKey::Player(player.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::Player(player.clone()))
    }

    pub fn save_player(env: &Env, player: &Address, state: &PlayerState) {
        Self::extend_persistent_ttl(env, &DataKey::Player(player.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::Player(player.clone()), state);
    }

    pub fn set_player_banned(env: &Env, player: &Address, banned: bool) {
        Self::extend_persistent_ttl(env, &DataKey::BannedPlayer(player.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::BannedPlayer(player.clone()), &banned);
    }

    pub fn is_player_banned(env: &Env, player: &Address) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::BannedPlayer(player.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::BannedPlayer(player.clone()))
            .unwrap_or(false)
    }

    pub fn save_player_limits(env: &Env, min_players: u32, max_players: u32) {
        Self::extend_persistent_ttl(env, &DataKey::MinPlayers);
        env.storage()
            .persistent()
            .set(&DataKey::MinPlayers, &min_players);
        Self::extend_persistent_ttl(env, &DataKey::MaxPlayers);
        env.storage()
            .persistent()
            .set(&DataKey::MaxPlayers, &max_players);
    }

    pub fn load_min_players(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::MinPlayers);
        env.storage()
            .persistent()
            .get(&DataKey::MinPlayers)
            .unwrap_or(crate::MIN_PLAYERS_TO_START)
    }

    pub fn load_max_players(env: &Env) -> Option<u32> {
        Self::extend_persistent_ttl(env, &DataKey::MaxPlayers);
        env.storage().persistent().get(&DataKey::MaxPlayers)
    }

    pub fn save_commitment(env: &Env, player: &Address, round: u32, commitment: &BytesN<32>) {
        Self::extend_persistent_ttl(env, &DataKey::CommitmentForRound(player.clone(), round));
        env.storage()
            .persistent()
            .set(&DataKey::CommitmentForRound(player.clone(), round), commitment);
    }

    pub fn load_commitment(env: &Env, player: &Address, round: u32) -> Option<BytesN<32>> {
        Self::extend_persistent_ttl(env, &DataKey::CommitmentForRound(player.clone(), round));
        env.storage()
            .persistent()
            .get(&DataKey::CommitmentForRound(player.clone(), round))
    }

    pub fn save_choice(env: &Env, player: &Address, round: u32, choice: &Choice) {
        Self::extend_persistent_ttl(env, &DataKey::ChoiceForRound(player.clone(), round));
        env.storage()
            .persistent()
            .set(&DataKey::ChoiceForRound(player.clone(), round), choice);
    }

    pub fn load_choice(env: &Env, player: &Address, round: u32) -> Option<Choice> {
        Self::extend_persistent_ttl(env, &DataKey::ChoiceForRound(player.clone(), round));
        env.storage()
            .persistent()
            .get(&DataKey::ChoiceForRound(player.clone(), round))
    }

    pub fn save_round_start(env: &Env, timestamp: u64) {
        Self::extend_persistent_ttl(env, &DataKey::RoundStart);
        env.storage()
            .persistent()
            .set(&DataKey::RoundStart, &timestamp);
    }

    pub fn load_round_start(env: &Env) -> Option<u64> {
        Self::extend_persistent_ttl(env, &DataKey::RoundStart);
        env.storage().persistent().get(&DataKey::RoundStart)
    }

    pub fn save_round_duration(env: &Env, duration_seconds: u64) {
        Self::extend_persistent_ttl(env, &DataKey::RoundDuration);
        env.storage()
            .persistent()
            .set(&DataKey::RoundDuration, &duration_seconds);
    }

    pub fn load_round_duration(env: &Env) -> u64 {
        Self::extend_persistent_ttl(env, &DataKey::RoundDuration);
        env.storage()
            .persistent()
            .get(&DataKey::RoundDuration)
            .unwrap_or(0)
    }

    pub fn save_round_yield_bps(env: &Env, round: u32, yield_bps: u32) {
        Self::extend_persistent_ttl(env, &DataKey::RoundYieldBps(round));
        env.storage()
            .persistent()
            .set(&DataKey::RoundYieldBps(round), &yield_bps);
    }

    pub fn save_yield_snapshot(env: &Env, round: u32, snapshot: &YieldSnapshot) {
        Self::extend_persistent_ttl(env, &DataKey::YieldSnapshot(round));
        env.storage()
            .persistent()
            .set(&DataKey::YieldSnapshot(round), snapshot);
    }

    pub fn load_yield_snapshot(env: &Env, round: u32) -> Option<YieldSnapshot> {
        Self::extend_persistent_ttl(env, &DataKey::YieldSnapshot(round));
        env.storage()
            .persistent()
            .get(&DataKey::YieldSnapshot(round))
    }

    pub fn save_round_result(env: &Env, round: u32, result: &RoundResult) {
        Self::extend_persistent_ttl(env, &DataKey::RoundResult(round));
        env.storage()
            .persistent()
            .set(&DataKey::RoundResult(round), result);
    }

    pub fn load_round_result(env: &Env, round: u32) -> Option<RoundResult> {
        Self::extend_persistent_ttl(env, &DataKey::RoundResult(round));
        env.storage().persistent().get(&DataKey::RoundResult(round))
    }

    pub fn save_last_vault_balance(env: &Env, balance: i128) {
        Self::extend_persistent_ttl(env, &DataKey::LastVaultBalance);
        env.storage()
            .persistent()
            .set(&DataKey::LastVaultBalance, &balance);
    }

    pub fn load_last_vault_balance(env: &Env) -> i128 {
        Self::extend_persistent_ttl(env, &DataKey::LastVaultBalance);
        env.storage()
            .persistent()
            .get(&DataKey::LastVaultBalance)
            .unwrap_or(0)
    }

    /// Returns true once the prize has been claimed for this arena. Read inside
    /// `claim` so a reentrant call sees the flag and bails out with
    /// `PrizeAlreadyClaimed` before the token transfer can run a second time.
    pub fn prize_claimed(env: &Env) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::PrizeClaimed);
        env.storage()
            .persistent()
            .get(&DataKey::PrizeClaimed)
            .unwrap_or(false)
    }

    /// Persist the prize-claimed flag. MUST be called before any external
    /// (cross-contract) call in `claim` so that a malicious token contract
    /// re-entering the arena cannot replay the claim.
    pub fn mark_prize_claimed(env: &Env) {
        Self::extend_persistent_ttl(env, &DataKey::PrizeClaimed);
        env.storage()
            .persistent()
            .set(&DataKey::PrizeClaimed, &true);
    }

    /// Return whether a state-changing entry point is already executing.
    pub fn reentrancy_guard_entered(env: &Env) -> bool {
        env.storage()
            .temporary()
            .get(&DataKey::ReentrancyGuard)
            .unwrap_or(false)
    }

    /// Set the temporary reentrancy guard before state-changing logic performs
    /// any checks/effects/interactions.
    pub fn enter_reentrancy_guard(env: &Env) -> Result<(), ArenaError> {
        if Self::reentrancy_guard_entered(env) {
            return Err(ArenaError::ReentrantCall);
        }

        env.storage()
            .temporary()
            .set(&DataKey::ReentrancyGuard, &true);
        Ok(())
    }

    /// Clear the temporary reentrancy guard after a guarded entry point exits.
    pub fn exit_reentrancy_guard(env: &Env) {
        env.storage().temporary().remove(&DataKey::ReentrancyGuard);
    }

    pub fn load_creator_active_pools(env: &Env, creator: &Address) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::CreatorActivePools(creator.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::CreatorActivePools(creator.clone()))
            .unwrap_or(0)
    }

    pub fn save_creator_active_pools(env: &Env, creator: &Address, active_pools: u32) {
        Self::extend_persistent_ttl(env, &DataKey::CreatorActivePools(creator.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::CreatorActivePools(creator.clone()), &active_pools);
    }

    pub fn increment_creator_active_pools(env: &Env, creator: &Address) {
        let active_pools = Self::load_creator_active_pools(env, creator).saturating_add(1);
        Self::save_creator_active_pools(env, creator, active_pools);
    }

    pub fn decrement_creator_active_pools(env: &Env, creator: &Address) {
        let active_pools = Self::load_creator_active_pools(env, creator);
        if active_pools > 0 {
            Self::save_creator_active_pools(env, creator, active_pools - 1);
        }
    }

    #[allow(dead_code)]
    fn is_terminal_pool_state(state: &GameState) -> bool {
        matches!(state, GameState::Finished | GameState::Cancelled | GameState::Settled)
    }

    pub fn save_pending_admin(env: &Env, pending: &PendingAdmin) {
        Self::extend_persistent_ttl(env, &symbol_short!("PADMIN"));
        env.storage()
            .persistent()
            .set(&symbol_short!("PADMIN"), pending);
    }

    pub fn load_pending_admin(env: &Env) -> Option<PendingAdmin> {
        Self::extend_persistent_ttl(env, &symbol_short!("PADMIN"));
        env.storage().persistent().get(&symbol_short!("PADMIN"))
    }

    pub fn delete_pending_admin(env: &Env) {
        env.storage().persistent().remove(&symbol_short!("PADMIN"));
    }

    pub fn get_winner(env: &Env) -> Option<Address> {
        Self::extend_persistent_ttl(env, &DataKey::Winner);
        env.storage().persistent().get(&DataKey::Winner)
    }

    pub fn set_winner(env: &Env, winner: &Address) {
        Self::extend_persistent_ttl(env, &DataKey::Winner);
        env.storage().persistent().set(&DataKey::Winner, winner);
    }

    pub fn is_refund_claimed(env: &Env, player: &Address) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::RefundClaimed(player.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::RefundClaimed(player.clone()))
            .unwrap_or(false)
    }

    pub fn set_refund_claimed(env: &Env, player: &Address) {
        Self::extend_persistent_ttl(env, &DataKey::RefundClaimed(player.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::RefundClaimed(player.clone()), &true);
    }

    pub fn load_leaderboard(env: &Env) -> Vec<crate::types::LeaderboardEntry> {
        Self::extend_persistent_ttl(env, &DataKey::Leaderboard);
        env.storage()
            .persistent()
            .get(&DataKey::Leaderboard)
            .unwrap_or_else(|| Vec::new(env))
    }

    pub fn save_leaderboard(env: &Env, leaderboard: &Vec<crate::types::LeaderboardEntry>) {
        Self::extend_persistent_ttl(env, &DataKey::Leaderboard);
        env.storage()
            .persistent()
            .set(&DataKey::Leaderboard, leaderboard);
    }

    pub fn load_leaderboard_limit(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::LeaderboardLimit);
        env.storage()
            .persistent()
            .get(&DataKey::LeaderboardLimit)
            .unwrap_or(100)
    }

    pub fn save_leaderboard_limit(env: &Env, limit: u32) {
        Self::extend_persistent_ttl(env, &DataKey::LeaderboardLimit);
        env.storage()
            .persistent()
            .set(&DataKey::LeaderboardLimit, &limit);
    }

    pub fn save_pending_upgrade(env: &Env, upgrade: &PendingUpgrade) {
        Self::extend_persistent_ttl(env, &symbol_short!("UPGRADE"));
        env.storage()
            .persistent()
            .set(&symbol_short!("UPGRADE"), upgrade);
    }

    pub fn load_pending_upgrade(env: &Env) -> Option<PendingUpgrade> {
        Self::extend_persistent_ttl(env, &symbol_short!("UPGRADE"));
        env.storage().persistent().get(&symbol_short!("UPGRADE"))
    }

    pub fn clear_pending_upgrade(env: &Env) {
        env.storage().persistent().remove(&symbol_short!("UPGRADE"));
    }

    /// Clear all players' choices and commitments for the specified round.
    /// Since commitments and choices are now keyed by (Address, round),
    /// this is primarily for cleanup. May be called at the start or end of a round.
    pub fn clear_round_data(env: &Env, round: u32) {
        let players = Self::load_all_players(env);
        for player in players.iter() {
            env.storage()
                .persistent()
                .remove(&DataKey::ChoiceForRound(player.clone(), round));
            env.storage()
                .persistent()
                .remove(&DataKey::CommitmentForRound(player.clone(), round));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ArenaContract;
    use soroban_sdk::testutils::Address as _;

    fn config(env: &Env, admin: &Address, state: GameState) -> ArenaConfig {
        ArenaConfig {
            admin: admin.clone(),
            stake_token: Address::generate(env),
            yield_vault: Address::generate(env),
            entry_fee: 100,
            state,
            paused: false,
            player_count: 0,
            cumulative_yield: 0,
            commit_deadline: 0,
            round_count: 0,
            oracle_contract: Address::generate(env),
        }
    }

    #[test]
    fn increment_and_decrement_creator_active_pools() {
        let env = Env::default();
        let contract_id = env.register(ArenaContract, ());
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(&env, &config(&env, &creator, GameState::Open));
            ArenaStorage::increment_creator_active_pools(&env, &creator);
            assert_eq!(ArenaStorage::load_creator_active_pools(&env, &creator), 1);

            ArenaStorage::save_config(&env, &config(&env, &creator, GameState::Finished));
            ArenaStorage::decrement_creator_active_pools(&env, &creator);
            assert_eq!(ArenaStorage::load_creator_active_pools(&env, &creator), 0);

            // Repeated decrement is a no-op (saturating at 0).
            ArenaStorage::decrement_creator_active_pools(&env, &creator);
            assert_eq!(ArenaStorage::load_creator_active_pools(&env, &creator), 0);
        });
    }

    #[test]
    fn decrement_creator_active_pools_never_underflows() {
        let env = Env::default();
        let contract_id = env.register(ArenaContract, ());
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            ArenaStorage::decrement_creator_active_pools(&env, &creator);
            ArenaStorage::decrement_creator_active_pools(&env, &creator);
            assert_eq!(ArenaStorage::load_creator_active_pools(&env, &creator), 0);
        });
    }
}
