#![allow(dead_code)]


const PENDING_ADMIN_KEY: &str = "PENDING_ADMIN";

/// Storage key for per-player data, keyed by the player's address.
#[contracttype]
enum DataKey {
    Player(Address),
    Commitment(Address),
    Choice(Address),
    YieldSnapshot(u32),
    RoundYieldBps(u32),
}

pub struct ArenaStorage;

impl ArenaStorage {
    pub fn load_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
        env.storage()
            .persistent()
            .get(&symbol_short!("CONFIG"))
            .ok_or(ArenaError::NotInitialised)
    }

    pub fn save_config(env: &Env, config: &ArenaConfig) {
        env.storage()
            .persistent()
            .set(&symbol_short!("CONFIG"), config);
    }


    }

    /// Return the list of all player addresses that have joined this arena.
    pub fn load_all_players(env: &Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&symbol_short!("PLAYERS"))
            .unwrap_or_else(|| Vec::new(env))
    }

    pub fn save_players(env: &Env, players: &Vec<Address>) {
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
        env.storage()
            .persistent()
            .get(&DataKey::Player(player.clone()))
    }

    pub fn save_player(env: &Env, player: &Address, state: &PlayerState) {
        env.storage()
            .persistent()
            .set(&DataKey::Player(player.clone()), state);
    }


    }
}

// Silence unused-import warnings until the full contract is wired up
const _: &str = PENDING_ADMIN_KEY;
