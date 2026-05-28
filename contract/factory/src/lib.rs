#![no_std]
#![allow(deprecated)]
use soroban_sdk::{Address, BytesN, Env, IntoVal, Symbol, Val, Vec, contract, contractimpl, symbol_short};

mod storage;

use storage::{ArenaEntry, FactoryStorage};

/// Factory contract — deploys arena instances and enforces protocol-level rules.
///
/// Architecture overview: see `ARCHITECTURE.md` in the workspace root.
#[contract]
pub struct FactoryContract;

#[contractimpl]
impl FactoryContract {
    /// Deploy a new arena contract with the given parameters.
    ///
    /// The caller (`creator`) is authenticated and becomes the arena admin.
    /// Returns the address of the newly deployed arena contract.
    pub fn deploy_arena(
        env: Env,
        creator: Address,
        entry_fee: i128,
        _max_players: u32,
        _join_deadline: u64,
        stake_token: Address,
        _yield_vault: Address,
        arena_wasm_hash: BytesN<32>,
    ) -> Address {
        creator.require_auth();

        // Build a deterministic salt from the creator and the next index
        let index = FactoryStorage::load_count(&env);
        let mut salt = [0u8; 32];
        let index_bytes = (index as u64).to_le_bytes();
        salt[..8].copy_from_slice(&index_bytes);
        let salt = BytesN::from_array(&env, &salt);

        // Deploy the arena contract
        let arena_id: Address = env
            .deployer()
            .with_current_contract(salt)
            .deploy(arena_wasm_hash);

        // Register the arena in storage
        let entry = ArenaEntry {
            arena_id: arena_id.clone(),
            creator: creator.clone(),
        };
        FactoryStorage::save_arena_entry(&env, index, &entry);
        FactoryStorage::increment_count(&env);

        // Initialise the arena via its `initialize` function
        let init_sym = Symbol::new(&env, "initialize");
        let mut args: Vec<Val> = Vec::new(&env);
        args.push_back(creator.into_val(&env));
        args.push_back(stake_token.into_val(&env));
        args.push_back(entry_fee.into_val(&env));
        env.invoke_contract::<()>(&arena_id, &init_sym, args);

        // Emit creation event
        let created_sym = symbol_short!("created");
        env.events().publish(
            (created_sym,),
            (arena_id.clone(), creator.clone()),
        );

        arena_id
    }

    /// Return a paginated list of all deployed arena addresses.
    ///
    /// `page` is 0-indexed; page size is 50 entries. Returns an empty list
    /// when the page is beyond the last entry.
    pub fn get_arenas(env: Env, page: u32) -> Vec<Address> {
        FactoryStorage::list_arenas(&env, page)
    }

    /// Return the total number of arenas deployed by this factory.
    pub fn arena_count(env: Env) -> u32 {
        FactoryStorage::load_count(&env)
    }
}
