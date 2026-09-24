use crate::types::PendingUpgrade;
use crate::types::{
    ArenaConfig, ArenaError, Choice, GameState, PendingAdmin, PlayerState, RoundResult,
    YieldSnapshot,
};
use soroban_sdk::{Address, BytesN, Env, IntoVal, Val, Vec, contracttype, symbol_short};

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
pub(crate) const PAGED_ROSTER_VERSION: u32 = 2;
const LEGACY_ROSTER_VERSION: u32 = 1;

/// Storage key for per-player data, keyed by the player's address.
#[contracttype]
pub(crate) enum DataKey {
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
    PlayerPage(u32),
    SurvivorPage(u32),
    RosterCount,
    SurvivorCount,
    StorageVersion,
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

    fn page_count(count: u32) -> u32 {
        if count == 0 {
            0
        } else {
            (count - 1) / crate::PAGE_SIZE + 1
        }
    }

    fn load_legacy_players(env: &Env) -> Option<Vec<Address>> {
        let key = symbol_short!("PLAYERS");
        Self::extend_persistent_ttl(env, &key);
        env.storage().persistent().get(&key)
    }

    fn remove_legacy_players(env: &Env) {
        env.storage().persistent().remove(&symbol_short!("PLAYERS"));
    }

    fn load_storage_version_raw(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::StorageVersion);
        env.storage()
            .persistent()
            .get(&DataKey::StorageVersion)
            .unwrap_or(LEGACY_ROSTER_VERSION)
    }

    pub fn load_storage_version(env: &Env) -> u32 {
        Self::ensure_paged_roster(env);
        Self::load_storage_version_raw(env)
    }

    fn save_storage_version(env: &Env, version: u32) {
        Self::extend_persistent_ttl(env, &DataKey::StorageVersion);
        env.storage()
            .persistent()
            .set(&DataKey::StorageVersion, &version);
    }

    fn load_roster_count_raw(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::RosterCount);
        env.storage()
            .persistent()
            .get(&DataKey::RosterCount)
            .unwrap_or(0)
    }

    pub fn load_roster_count(env: &Env) -> u32 {
        Self::ensure_paged_roster(env);
        Self::load_roster_count_raw(env)
    }

    pub(crate) fn save_roster_count(env: &Env, count: u32) {
        Self::extend_persistent_ttl(env, &DataKey::RosterCount);
        env.storage()
            .persistent()
            .set(&DataKey::RosterCount, &count);
    }

    fn load_survivor_count_raw(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::SurvivorCount);
        env.storage()
            .persistent()
            .get(&DataKey::SurvivorCount)
            .unwrap_or(0)
    }

    pub fn load_survivor_count(env: &Env) -> u32 {
        Self::ensure_paged_roster(env);
        Self::load_survivor_count_raw(env)
    }

    pub(crate) fn save_survivor_count(env: &Env, count: u32) {
        Self::extend_persistent_ttl(env, &DataKey::SurvivorCount);
        env.storage()
            .persistent()
            .set(&DataKey::SurvivorCount, &count);
    }

    fn load_roster_page_raw(env: &Env, page: u32) -> Vec<Address> {
        Self::extend_persistent_ttl(env, &DataKey::PlayerPage(page));
        env.storage()
            .persistent()
            .get(&DataKey::PlayerPage(page))
            .unwrap_or_else(|| Vec::new(env))
    }

    pub fn load_roster_page(env: &Env, page: u32) -> Vec<Address> {
        Self::ensure_paged_roster(env);
        Self::load_roster_page_raw(env, page)
    }

    pub(crate) fn save_roster_page(env: &Env, page: u32, players: &Vec<Address>) {
        Self::extend_persistent_ttl(env, &DataKey::PlayerPage(page));
        env.storage()
            .persistent()
            .set(&DataKey::PlayerPage(page), players);
    }

    fn load_survivor_page_raw(env: &Env, page: u32) -> Vec<Address> {
        Self::extend_persistent_ttl(env, &DataKey::SurvivorPage(page));
        env.storage()
            .persistent()
            .get(&DataKey::SurvivorPage(page))
            .unwrap_or_else(|| Vec::new(env))
    }

    pub fn load_survivor_page(env: &Env, page: u32) -> Vec<Address> {
        Self::ensure_paged_roster(env);
        Self::load_survivor_page_raw(env, page)
    }

    pub(crate) fn save_survivor_page(env: &Env, page: u32, players: &Vec<Address>) {
        Self::extend_persistent_ttl(env, &DataKey::SurvivorPage(page));
        env.storage()
            .persistent()
            .set(&DataKey::SurvivorPage(page), players);
    }

    fn write_roster_pages(env: &Env, players: &Vec<Address>) {
        let previous_pages = Self::page_count(Self::load_roster_count_raw(env));
        let mut page = Vec::new(env);
        let mut page_index = 0u32;
        for player in players.iter() {
            page.push_back(player);
            if page.len() == crate::PAGE_SIZE {
                Self::save_roster_page(env, page_index, &page);
                page = Vec::new(env);
                page_index = page_index.saturating_add(1);
            }
        }
        if !page.is_empty() {
            Self::save_roster_page(env, page_index, &page);
        }
        Self::remove_stale_pages(env, previous_pages, Self::page_count(players.len()), false);
    }

    fn write_survivor_pages(env: &Env, players: &Vec<Address>) {
        let previous_pages = Self::page_count(Self::load_survivor_count_raw(env));
        let mut page = Vec::new(env);
        let mut page_index = 0u32;
        for player in players.iter() {
            page.push_back(player);
            if page.len() == crate::PAGE_SIZE {
                Self::save_survivor_page(env, page_index, &page);
                page = Vec::new(env);
                page_index = page_index.saturating_add(1);
            }
        }
        if !page.is_empty() {
            Self::save_survivor_page(env, page_index, &page);
        }
        Self::remove_stale_pages(env, previous_pages, Self::page_count(players.len()), true);
    }

    fn remove_stale_pages(env: &Env, previous_pages: u32, current_pages: u32, survivors: bool) {
        for page_index in current_pages..previous_pages {
            let key = if survivors {
                DataKey::SurvivorPage(page_index)
            } else {
                DataKey::PlayerPage(page_index)
            };
            env.storage().persistent().remove(&key);
        }
    }

    fn load_existing_roster_pages(env: &Env) -> Vec<Address> {
        let total = Self::load_roster_count_raw(env);
        let mut players = Vec::new(env);
        for page_index in 0..Self::page_count(total) {
            let page = Self::load_roster_page_raw(env, page_index);
            for player in page.iter() {
                players.push_back(player);
            }
        }
        players
    }

    pub fn initialize_paged_roster(env: &Env) {
        Self::save_storage_version(env, PAGED_ROSTER_VERSION);
        Self::save_roster_count(env, 0);
        Self::save_survivor_count(env, 0);
    }

    pub fn ensure_paged_roster(env: &Env) {
        if Self::load_storage_version_raw(env) >= PAGED_ROSTER_VERSION {
            return;
        }

        let legacy = Self::load_legacy_players(env);
        let has_legacy = legacy.is_some();
        let players = match legacy {
            Some(players) => players,
            None => Self::load_existing_roster_pages(env),
        };
        Self::write_roster_pages(env, &players);

        let mut survivors = Vec::new(env);
        for player in players.iter() {
            if let Some(state) = Self::load_player(env, &player)
                && state.active
                && !survivors.contains(&player)
            {
                survivors.push_back(player);
            }
        }
        Self::write_survivor_pages(env, &survivors);
        Self::save_roster_count(env, players.len());
        Self::save_survivor_count(env, survivors.len());
        if let Ok(mut config) = Self::load_config(env) {
            config.player_count = players.len();
            config.active_player_count = survivors.len();
            Self::save_config(env, &config);
        }
        if has_legacy {
            Self::remove_legacy_players(env);
        }
        Self::save_storage_version(env, PAGED_ROSTER_VERSION);
    }

    pub fn migrate_legacy_players(env: &Env) {
        Self::ensure_paged_roster(env);
    }

    /// Return the list of all player addresses that have joined this arena.
    pub fn load_all_players(env: &Env) -> Vec<Address> {
        Self::ensure_paged_roster(env);
        let total = Self::load_roster_count_raw(env);
        let mut players = Vec::new(env);
        for page_index in 0..Self::page_count(total) {
            let page = Self::load_roster_page_raw(env, page_index);
            for player in page.iter() {
                players.push_back(player);
            }
        }
        players
    }

    /// Return up to `count` player addresses starting at index `start`.
    ///
    /// Versioned arenas read one page entry. Legacy arenas use a read-only
    /// fallback until the next state-changing entry point migrates the roster.
    pub fn load_player_page(env: &Env, start: u32, count: u32) -> Vec<Address> {
        if count == 0 {
            return Vec::new(env);
        }
        if Self::load_storage_version_raw(env) < PAGED_ROSTER_VERSION {
            let players = match Self::load_legacy_players(env) {
                Some(players) => players,
                None => Self::load_existing_roster_pages(env),
            };
            return Self::slice_player_page(env, &players, start, count);
        }

        let page_index = start / crate::PAGE_SIZE;
        let offset = start % crate::PAGE_SIZE;
        let page = Self::load_roster_page_raw(env, page_index);
        Self::slice_player_page(env, &page, offset, count)
    }

    fn slice_player_page(
        env: &Env,
        players: &Vec<Address>,
        start: u32,
        count: u32,
    ) -> Vec<Address> {
        if start >= players.len() {
            return Vec::new(env);
        }
        let end = start.saturating_add(count).min(players.len());
        let mut result = Vec::new(env);
        for index in start..end {
            if let Some(player) = players.get(index) {
                result.push_back(player);
            }
        }
        result
    }

    pub fn save_players(env: &Env, players: &Vec<Address>) {
        let roster_pages = Self::page_count(Self::load_roster_count_raw(env));
        let survivor_pages = Self::page_count(Self::load_survivor_count_raw(env));
        Self::remove_stale_pages(env, roster_pages, 0, false);
        Self::remove_stale_pages(env, survivor_pages, 0, true);
        let key = symbol_short!("PLAYERS");
        Self::extend_persistent_ttl(env, &key);
        env.storage().persistent().set(&key, players);
        Self::save_storage_version(env, LEGACY_ROSTER_VERSION);
        env.storage().persistent().remove(&DataKey::RosterCount);
        env.storage().persistent().remove(&DataKey::SurvivorCount);
    }

    fn append_roster_player(env: &Env, player: &Address, count: u32) {
        let mut page_index = count / crate::PAGE_SIZE;
        let mut page = Self::load_roster_page_raw(env, page_index);
        if page.len() >= crate::PAGE_SIZE {
            page_index = page_index.saturating_add(1);
            page = Self::load_roster_page_raw(env, page_index);
        }
        page.push_back(player.clone());
        Self::save_roster_page(env, page_index, &page);
    }

    fn append_survivor_player(env: &Env, player: &Address, count: u32) {
        let mut page_index = count / crate::PAGE_SIZE;
        let mut page = Self::load_survivor_page_raw(env, page_index);
        if page.len() >= crate::PAGE_SIZE {
            page_index = page_index.saturating_add(1);
            page = Self::load_survivor_page_raw(env, page_index);
        }
        page.push_back(player.clone());
        Self::save_survivor_page(env, page_index, &page);
    }

    pub fn add_player(env: &Env, player: &Address) {
        Self::ensure_paged_roster(env);
        let count = Self::load_roster_count_raw(env);
        if count == u32::MAX {
            return;
        }
        Self::append_roster_player(env, player, count);
        Self::save_roster_count(env, count + 1);

        let survivor_count = Self::load_survivor_count_raw(env);
        Self::append_survivor_player(env, player, survivor_count);
        Self::save_survivor_count(env, survivor_count.saturating_add(1));

        Self::save_player(
            env,
            player,
            &PlayerState {
                active: true,
                rounds_survived: 0,
            },
        );

        if let Ok(mut config) = Self::load_config(env) {
            config.player_count = count + 1;
            config.active_player_count = config.active_player_count.saturating_add(1);
            Self::save_config(env, &config);
        }
    }

    pub fn load_active_roster(env: &Env) -> Vec<Address> {
        Self::ensure_paged_roster(env);
        let total = Self::load_roster_count_raw(env);
        let mut active = Vec::new(env);
        for page_index in 0..Self::page_count(total) {
            let page = Self::load_roster_page_raw(env, page_index);
            for player in page.iter() {
                if active.contains(&player) {
                    continue;
                }
                if let Some(state) = Self::load_player(env, &player)
                    && state.active
                {
                    active.push_back(player);
                }
            }
        }
        active
    }

    pub fn load_survivor_index(env: &Env) -> Vec<Address> {
        Self::ensure_paged_roster(env);
        let total = Self::load_survivor_count_raw(env);
        let mut active = Vec::new(env);
        for page_index in 0..Self::page_count(total) {
            let page = Self::load_survivor_page_raw(env, page_index);
            for player in page.iter() {
                if !active.contains(&player) {
                    active.push_back(player);
                }
            }
        }
        active
    }

    pub fn rebuild_survivor_index(env: &Env, players: &Vec<Address>) {
        Self::ensure_paged_roster(env);
        Self::write_survivor_pages(env, players);
        Self::save_survivor_count(env, players.len());
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
        Self::ensure_paged_roster(env);
        let total = Self::load_roster_count_raw(env);
        for page_index in 0..Self::page_count(total) {
            let page = Self::load_roster_page_raw(env, page_index);
            for player in page.iter() {
                env.storage()
                    .persistent()
                    .remove(&DataKey::ChoiceForRound(player.clone(), round));
                env.storage()
                    .persistent()
                    .remove(&DataKey::CommitmentForRound(player.clone(), round));
            }
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

    #[test]
    fn paged_roster_handles_empty_boundaries_and_maximum_roster() {
        let env = Env::default();
        let contract_id = env.register(ArenaContract, ());
        let admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(&env, &config(&env, &admin, GameState::Open));
            assert_eq!(ArenaStorage::load_roster_count(&env), 0);
            assert!(ArenaStorage::load_roster_page(&env, 0).is_empty());
            assert!(ArenaStorage::load_player_page(&env, 0, 0).is_empty());

            for _ in 0..100 {
                ArenaStorage::add_player(&env, &Address::generate(&env));
            }

            assert_eq!(ArenaStorage::load_roster_count(&env), 100);
            assert_eq!(ArenaStorage::load_roster_page(&env, 0).len(), 50);
            assert_eq!(ArenaStorage::load_roster_page(&env, 1).len(), 50);
            assert!(ArenaStorage::load_roster_page(&env, 2).is_empty());
            assert!(ArenaStorage::load_player_page(&env, u32::MAX, 50).is_empty());
        });
    }

    #[test]
    fn legacy_roster_migration_is_complete_and_idempotent() {
        let env = Env::default();
        let contract_id = env.register(ArenaContract, ());
        let admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(&env, &config(&env, &admin, GameState::Open));
            let mut legacy = Vec::new(&env);
            for index in 0..51 {
                let player = Address::generate(&env);
                legacy.push_back(player.clone());
                ArenaStorage::save_player(
                    &env,
                    &player,
                    &PlayerState {
                        active: index % 3 != 0,
                        rounds_survived: 0,
                    },
                );
            }
            ArenaStorage::save_players(&env, &legacy);
            assert_eq!(ArenaStorage::load_player_page(&env, 0, 50).len(), 50);
            assert_eq!(ArenaStorage::load_player_page(&env, 50, 50).len(), 1);
            assert_eq!(
                ArenaStorage::load_storage_version_raw(&env),
                LEGACY_ROSTER_VERSION
            );

            ArenaStorage::migrate_legacy_players(&env);
            let migrated = ArenaStorage::load_all_players(&env);
            assert_eq!(
                ArenaStorage::load_storage_version(&env),
                PAGED_ROSTER_VERSION
            );
            assert_eq!(ArenaStorage::load_roster_count(&env), 51);
            assert_eq!(ArenaStorage::load_survivor_count(&env), 34);
            assert_eq!(migrated.len(), legacy.len());
            for index in 0..legacy.len() {
                assert_eq!(migrated.get(index), legacy.get(index));
            }
            assert!(!env.storage().persistent().has(&symbol_short!("PLAYERS")));

            let before = ArenaStorage::load_roster_page(&env, 0);
            ArenaStorage::migrate_legacy_players(&env);
            assert_eq!(ArenaStorage::load_roster_page(&env, 0), before);
        });
    }
}
