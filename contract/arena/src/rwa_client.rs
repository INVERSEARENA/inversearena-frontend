use soroban_sdk::{Address, Env, contractclient};

#[allow(dead_code)]
/// Minimal cross-contract client interface for the RWA adapter vault.
///
/// Defined locally so the arena WASM does not link the full rwa-adapter
/// implementation (which would cause duplicate `initialize` symbol conflicts
/// when linking). The SDK generates `RwaAdapterClient` and the corresponding
/// `try_*` variants from this trait.
#[contractclient(name = "RwaAdapterClient")]
pub trait RwaAdapterInterface {
    fn deposit(env: Env, from: Address, amount: i128);
    fn withdraw_all(env: Env, from: Address) -> i128;
    fn balance_of(env: Env, user: Address) -> i128;
    fn get_total_deposited(env: Env) -> i128;
}
