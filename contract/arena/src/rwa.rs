/// RWA yield vault adapter for the ArenaContract.
use soroban_sdk::IntoVal;
///
/// Provides a thin layer over cross-contract vault calls so the rest of the
/// arena logic stays decoupled from the specific vault interface.
///
/// # Fallback behaviour
///
/// All vault interaction in the arena is gated on the `VAULT_ACTIVE_KEY` flag.
/// When the primary vault is unavailable, the admin calls
/// `toggle_vault_active(false)` before game completion. This emits a
/// `VaultFallbackActivated` event and causes `complete_with_yield` to fall
/// back to awarding the on-hand principal with zero yield, ensuring no winner
/// payout is ever blocked by an external dependency.
///
/// In Soroban, cross-contract `invoke_contract` calls panic (reverting the
/// transaction) if the callee panics — there is no in-transaction catch.
/// The admin-toggled fallback is therefore the primary mechanism for graceful
/// degradation. A secondary fallback vault address can be configured via
/// `set_fallback_vault` for future use when the SDK supports try-invocations.
///
/// # Vault interface
///
/// The primary (and fallback) vault is expected to expose:
/// - `deposit(token: Address, amount: i128) -> i128`  — returns shares minted.
/// - `withdraw(shares: i128) -> i128`                 — burns shares, returns tokens.
pub struct RwaVaultAdapter;

use soroban_sdk::IntoVal;

impl RwaVaultAdapter {
    /// Call `vault.deposit(token, amount)` and return the shares minted.
    ///
    /// The caller must have already transferred `amount` tokens to `vault`
    /// before calling this, or the vault must pull them via an approval.
    pub fn deposit(
        env: &soroban_sdk::Env,
        vault: &soroban_sdk::Address,
        token: soroban_sdk::Address,
        amount: i128,
    ) -> i128 {
        env.invoke_contract(
            vault,
            &soroban_sdk::Symbol::new(env, "deposit"),
            soroban_sdk::vec![env, token.into_val(env), amount.into_val(env)],
        )
    }

    /// Call `vault.withdraw(shares)` and return the tokens received.
    pub fn withdraw(env: &soroban_sdk::Env, vault: &soroban_sdk::Address, shares: i128) -> i128 {
        env.invoke_contract(
            vault,
            &soroban_sdk::Symbol::new(env, "withdraw"),
            soroban_sdk::vec![env, shares.into_val(env)],
        )
    }
}
