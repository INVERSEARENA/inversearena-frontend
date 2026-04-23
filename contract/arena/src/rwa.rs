use soroban_sdk::{Address, Env};

/// Placeholder for the RWA vault / payout cross-contract call.
/// Replace with a generated `contractclient!` client when the vault contract is ready.
pub fn call_payout_contract(env: &Env, winner: Address, prize_pool: i128, yield_earned: i128) {
    let _ = (env, winner, prize_pool, yield_earned);
}
