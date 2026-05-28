use soroban_sdk::{Address, Env, Vec, contracttype, symbol_short};

const PAGE_SIZE: u32 = 50;

/// Storage key for the arena registry.
#[contracttype]
enum DataKey {
    ArenaEntry(u32),
    ArenaCreator(Address),
}

/// Metadata for a single deployed arena.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaEntry {
    pub arena_id: Address,
    pub creator: Address,
}

/// Total number of arenas deployed.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaCount {
    pub count: u32,
}

pub struct FactoryStorage;

impl FactoryStorage {
    /// Save an arena entry at the given index.
    pub fn save_arena_entry(env: &Env, index: u32, entry: &ArenaEntry) {
        env.storage()
            .persistent()
            .set(&DataKey::ArenaEntry(index), entry);
    }

    /// Load an arena entry at the given index.
    pub fn load_arena_entry(env: &Env, index: u32) -> Option<ArenaEntry> {
        env.storage()
            .persistent()
            .get(&DataKey::ArenaEntry(index))
    }

    /// Increment the arena counter and return the new index.
    pub fn increment_count(env: &Env) -> u32 {
        let current = Self::load_count(env);
        let next = current + 1;
        env.storage()
            .persistent()
            .set(&symbol_short!("ACOUNT"), &ArenaCount { count: next });
        next
    }

    /// Load the total number of arenas deployed.
    pub fn load_count(env: &Env) -> u32 {
        env.storage()
            .persistent()
            .get::<_, ArenaCount>(&symbol_short!("ACOUNT"))
            .map(|c| c.count)
            .unwrap_or(0)
    }

    /// Return a paginated list of all deployed arena addresses.
    ///
    /// `page` is 0-indexed; page size is 50. Returns an empty vec beyond the
    /// last page.
    pub fn list_arenas(env: &Env, page: u32) -> Vec<Address> {
        let total = Self::load_count(env);
        let start = page.saturating_mul(PAGE_SIZE);
        let end = start.saturating_add(PAGE_SIZE).min(total);

        let mut result: Vec<Address> = Vec::new(env);
        let mut i = start;
        while i < end {
            if let Some(entry) = Self::load_arena_entry(env, i) {
                result.push_back(entry.arena_id);
            }
            i += 1;
        }
        result
    }
}
