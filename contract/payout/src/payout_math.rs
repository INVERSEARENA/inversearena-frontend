//! Pure payout and yield arithmetic.
//!
//! Refactored out of Env-dependent code so Kani bounded model checking can prove:
//! - Total payout (principal + yield) never exceeds the amount withdrawn from the vault.
//! - Payout never exceeds the winner's entitlement (principal + cumulative_yield).
//! - Yield distributed is never negative.

/// Calculate the safe payout distribution.
///
/// Invariants:
/// - `principal = entry_fee * player_count`.
/// - `entitlement = principal + cumulative_yield`.
/// - If `withdrawn < entitlement`, payout is bounded by `withdrawn`.
/// - The total payout distributed is `min(entitlement, withdrawn)`.
/// - Returns `(payout_total, yield_component)`.
pub fn calculate_payout_distribution(
    entry_fee: i128,
    player_count: u32,
    cumulative_yield: i128,
    withdrawn: i128,
) -> (i128, i128) {
    if entry_fee < 0 || withdrawn <= 0 {
        return (0, 0);
    }
    let principal = entry_fee.saturating_mul(i128::from(player_count));
    let valid_yield = cumulative_yield.max(0);
    let entitlement = principal.saturating_add(valid_yield);
    let actual_payout = core::cmp::min(entitlement, withdrawn);
    let yield_paid = actual_payout.saturating_sub(principal).max(0);
    (actual_payout, yield_paid)
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    /// Proves that the actual distributed payout NEVER exceeds the withdrawn vault balance.
    #[kani::proof]
    fn proof_payout_never_exceeds_withdrawn() {
        let entry_fee: i128 = kani::any();
        let player_count: u32 = kani::any();
        let cumulative_yield: i128 = kani::any();
        let withdrawn: i128 = kani::any();

        kani::assume(entry_fee >= 0 && entry_fee < 1_000_000_000);
        kani::assume(player_count <= 10_000);
        kani::assume(cumulative_yield >= 0 && cumulative_yield < 1_000_000_000_000);
        kani::assume(withdrawn >= 0 && withdrawn < 1_000_000_000_000);

        let (payout, yield_paid) = calculate_payout_distribution(
            entry_fee,
            player_count,
            cumulative_yield,
            withdrawn,
        );

        // Core money-conservation invariants:
        // 1. Payout never exceeds withdrawn funds
        assert!(payout <= withdrawn);

        // 2. Principal + yield never exceeds withdrawn funds
        let principal = entry_fee * (player_count as i128);
        assert!(principal.min(payout) + yield_paid <= withdrawn);

        // 3. Yield paid is never negative and never exceeds cumulative yield
        assert!(yield_paid >= 0);
        assert!(yield_paid <= cumulative_yield);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_full_withdrawal_covers_entitlement() {
        // 10 players * 100 fee = 1000 principal, 250 yield = 1250 total.
        // Withdrawn = 1300 -> payout = 1250, yield = 250.
        let (payout, yield_paid) = calculate_payout_distribution(100, 10, 250, 1300);
        assert_eq!(payout, 1250);
        assert_eq!(yield_paid, 250);
    }

    #[test]
    fn test_shortfall_caps_at_withdrawn() {
        // Entitlement 1250, but vault only yielded 1100 total withdrawn.
        let (payout, yield_paid) = calculate_payout_distribution(100, 10, 250, 1100);
        assert_eq!(payout, 1100);
        assert_eq!(yield_paid, 100);
        assert!(payout <= 1100);
    }

    #[test]
    fn test_severe_shortfall_less_than_principal() {
        // Entitlement 1250, vault only returned 800.
        let (payout, yield_paid) = calculate_payout_distribution(100, 10, 250, 800);
        assert_eq!(payout, 800);
        assert_eq!(yield_paid, 0);
        assert!(payout <= 800);
    }
}
