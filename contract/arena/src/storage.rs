use crate::types::PendingUpgrade;
use crate::types::{
    ArenaConfig, ArenaError, Choice, GameState, PendingAdmin, PlayerState, RoundResult,
    YieldSnapshot,
};
use soroban_sdk::{Address, BytesN, Env, IntoVal, Val, Vec, contracttype, symbol_short, storage::Persistent, symbol};

pub trait StorageRepository<K, V> {
    fn has(env: &Env, key: &K) -> bool;
    fn get(env: &Env, key: &K) -> Option<V>;
    fn set(env: &Env, key: &K, val: &V);
    fn remove(env: &Env, key: &K);
}

pub trait TtlRepository<K> {
    fn extend_ttl(env: &Env, key: &K, threshold: u32, extend_to: u32);
}


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
    Winner,
    RefundClaimed(Address),
    Leaderboard,
    LeaderboardLimit,
    PlatformFeeBps,
}


pub struct ArenaRepository<'a> {
    env: &'a Env,
}

impl<'a> ArenaRepository<'a> {
    pub fn new(env: &'a Env) -> Self {
        ArenaRepository { env }
    }

    // Generic function to extend TTL for any persistent key
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
}

// Implement StorageRepository for DataKey and various Value types
impl StorageRepository<DataKey, PlayerState> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<PlayerState> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &PlayerState) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, bool> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<bool> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &bool) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, u32> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<u32> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &u32) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, BytesN<32>> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<BytesN<32>> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &BytesN<32>) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, Choice> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<Choice> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &Choice) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, u64> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<u64> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &u64) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, i128> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<i128> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &i128) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, YieldSnapshot> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<YieldSnapshot> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &YieldSnapshot) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, RoundResult> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<RoundResult> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &RoundResult) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, Address> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<Address> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &Address) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, Vec<Address>> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<Vec<Address>> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &Vec<Address>) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, crate::types::LeaderboardEntry> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<crate::types::LeaderboardEntry> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &crate::types::LeaderboardEntry) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<DataKey, Vec<crate::types::LeaderboardEntry>> for ArenaRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &DataKey) -> Option<Vec<crate::types::LeaderboardEntry>> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &DataKey, val: &Vec<crate::types::LeaderboardEntry>) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

// Implement TTLRepository for DataKey
impl TtlRepository<DataKey> for ArenaRepository<'_> {
    fn extend_ttl(env: &Env, key: &DataKey, threshold: u32, extend_to: u32) {
        if env.storage().persistent().has(key) {
            env.storage().persistent().extend_ttl(key, threshold, extend_to);
        }
    }
}

// Implement StorageRepository for Symbol and various Value types (for instance storage)
impl StorageRepository<soroban_sdk::Symbol, ArenaConfig> for ArenaRepository<'_> {
    fn has(env: &Env, key: &soroban_sdk::Symbol) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &soroban_sdk::Symbol) -> Option<ArenaConfig> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &soroban_sdk::Symbol, val: &ArenaConfig) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &soroban_sdk::Symbol) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<soroban_sdk::Symbol, Vec<Address>> for ArenaRepository<'_> {
    fn has(env: &Env, key: &soroban_sdk::Symbol) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &soroban_sdk::Symbol) -> Option<Vec<Address>> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &soroban_sdk::Symbol, val: &Vec<Address>) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &soroban_sdk::Symbol) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<soroban_sdk::Symbol, PendingAdmin> for ArenaRepository<'_> {
    fn has(env: &Env, key: &soroban_sdk::Symbol) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &soroban_sdk::Symbol) -> Option<PendingAdmin> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &soroban_sdk::Symbol, val: &PendingAdmin) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &soroban_sdk::Symbol) {
        env.storage().persistent().remove(key);
    }
}

impl StorageRepository<soroban_sdk::Symbol, PendingUpgrade> for ArenaRepository<'_> {
    fn has(env: &Env, key: &soroban_sdk::Symbol) -> bool {
        env.storage().persistent().has(key)
    }
    fn get(env: &Env, key: &soroban_sdk::Symbol) -> Option<PendingUpgrade> {
        env.storage().persistent().get(key)
    }
    fn set(env: &Env, key: &soroban_sdk::Symbol, val: &PendingUpgrade) {
        env.storage().persistent().set(key, val);
    }
    fn remove(env: &Env, key: &soroban_sdk::Symbol) {
        env.storage().persistent().remove(key);
    }
}

// Implement TTLRepository for Symbol (for instance storage)
impl TtlRepository<soroban_sdk::Symbol> for ArenaRepository<'_> {
    fn extend_ttl(env: &Env, key: &soroban_sdk::Symbol, threshold: u32, extend_to: u32) {
        if env.storage().persistent().has(key) {
            env.storage().persistent().extend_ttl(key, threshold, extend_to);
        }
    }
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

    /// Return up to `count` player addresses starting at index `start`.
    ///
    /// Reads only the single storage entry that covers the requested range,
    /// avoiding the O(n) full-list deserialisation that `load_all_players`
    /// would incur for large arenas.
    pub fn load_player_page(env: &Env, start: u32, count: u32) -> Vec<Address> {
        let all = Self::load_all_players(env);
        let total = all.len();
        if start >= total {
            return Vec::new(env);
        }
        let end = (start.saturating_add(count)).min(total);
        let mut page: Vec<Address> = Vec::new(env);
        for i in start..end {
            if let Some(addr) = all.get(i) {
                page.push_back(addr);
            }
        }
        page
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

        // Keep the cached player count and active player count in `config` in sync.
        if let Ok(mut config) = Self::load_config(env) {
            config.player_count = players.len();
            config.active_player_count = config.active_player_count.saturating_add(1);
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
        env.storage().persistent().set(
            &DataKey::CommitmentForRound(player.clone(), round),
            commitment,
        );
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

    /// Remove a single player's choice for a round (#1075: clear stale choice on elimination).
    pub fn remove_player_choice(env: &Env, player: &Address, round: u32) {
        env.storage()
            .persistent()
            .remove(&DataKey::ChoiceForRound(player.clone(), round));
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

    #[allow(dead_code)]
    fn is_terminal_pool_state(state: &GameState) -> bool {
        matches!(
            state,
            GameState::Finished | GameState::Cancelled | GameState::Settled
        )
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

    /// Global platform fee in basis points. Defaults to 1000 (10%) until the
    /// admin calls `update_platform_fee`. New arenas snapshot this value into
    /// their `ArenaConfig.platform_fee_bps` at `initialize` time.
    pub fn load_platform_fee_bps(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::PlatformFeeBps);
        env.storage()
            .persistent()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(1000)
    }

    pub fn save_platform_fee_bps(env: &Env, fee_bps: u32) {
        Self::extend_persistent_ttl(env, &DataKey::PlatformFeeBps);
        env.storage()
            .persistent()
            .set(&DataKey::PlatformFeeBps, &fee_bps);
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
            active_player_count: 0,
            cumulative_yield: 0,
            commit_deadline: 0,
            round_count: 0,
            oracle_contract: Address::generate(env),
            factory: Address::generate(env),
            pool_id: 0,
            platform_fee_bps: 1000,
        }
    }
}
