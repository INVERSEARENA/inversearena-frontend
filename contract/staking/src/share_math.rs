//! Pure staking share and amount conversion arithmetic.
//!
//! Refactored out of Env-dependent code so it can be verified with Kani bounded
//! model checking and property testing.

use crate::types::StakingError;

/// Calculate the number of shares minted for a deposit of `amount`.
///
/// Invariants:
/// - When pool is empty (`total_shares == 0`), deposit must be at least `min_initial`.
///   Shares minted equal `amount`.
/// - When pool is non-empty, `shares = floor(amount * total_shares / total_staked)`.
/// - If `shares == 0`, rejected with `ZeroShares`.
/// - Rounding always rounds down, protecting existing stakers from share dilution.
pub fn calculate_stake_shares(
    amount: i128,
    total_staked: i128,
    total_shares: i128,
    min_initial: i128,
) -> Result<i128, StakingError> {
    if amount <= 0 {
        return Err(StakingError::InvalidAmount);
    }
    if total_shares == 0 {
        if amount < min_initial {
            return Err(StakingError::BelowMinimumInitialStake);
        }
        Ok(amount)
    } else {
        if total_staked <= 0 {
            return Err(StakingError::ArithmeticOverflow);
        }
        let s = amount
            .checked_mul(total_shares)
            .and_then(|scaled| scaled.checked_div(total_staked))
            .ok_or(StakingError::ArithmeticOverflow)?;
        if s == 0 {
            return Err(StakingError::ZeroShares);
        }
        Ok(s)
    }
}

/// Calculate the number of tokens redeemed when unstaking `shares`.
///
/// Invariants:
/// - `tokens = floor(shares * total_staked / total_shares)`.
/// - Rounding always rounds down, ensuring tokens redeemed never exceed the caller's pro-rata claim.
pub fn calculate_unstake_tokens(
    shares: i128,
    total_staked: i128,
    total_shares: i128,
) -> Result<i128, StakingError> {
    if shares <= 0 {
        return Err(StakingError::InvalidAmount);
    }
    if total_shares == 0 {
        return Err(StakingError::NoSharesOutstanding);
    }
    if total_staked < 0 {
        return Err(StakingError::ArithmeticOverflow);
    }
    shares
        .checked_mul(total_staked)
        .and_then(|scaled| scaled.checked_div(total_shares))
        .ok_or(StakingError::ArithmeticOverflow)
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    /// Proves that depositing `amount` and then immediately redeeming the resulting shares
    /// never returns more tokens than `amount` (no rounding favors the caller).
    #[kani::proof]
    fn proof_stake_unstake_never_favours_caller() {
        let amount: i128 = kani::any();
        let total_staked: i128 = kani::any();
        let total_shares: i128 = kani::any();
        let min_initial: i128 = 10;

        kani::assume(amount > 0 && amount < 1_000_000_000);
        kani::assume(total_staked > 0 && total_staked < 1_000_000_000_000);
        kani::assume(total_shares > 0 && total_shares < 1_000_000_000_000);

        if let Ok(minted_shares) = calculate_stake_shares(amount, total_staked, total_shares, min_initial) {
            // Updated pool state
            let new_staked = total_staked + amount;
            let new_shares = total_shares + minted_shares;

            if let Ok(redeemed_tokens) = calculate_unstake_tokens(minted_shares, new_staked, new_shares) {
                // The caller can NEVER extract more tokens than they deposited!
                assert!(redeemed_tokens <= amount);
            }
        }
    }

    /// Proves that unstaking `shares` never extracts a greater proportion of the pool
    /// than `shares / total_shares`.
    #[kani::proof]
    fn proof_unstake_tokens_never_exceeds_pro_rata() {
        let shares: i128 = kani::any();
        let total_staked: i128 = kani::any();
        let total_shares: i128 = kani::any();

        kani::assume(shares > 0 && shares <= total_shares);
        kani::assume(total_staked > 0 && total_staked < 1_000_000_000_000);
        kani::assume(total_shares > 0 && total_shares < 1_000_000_000_000);

        if let Ok(tokens) = calculate_unstake_tokens(shares, total_staked, total_shares) {
            // tokens * total_shares <= shares * total_staked
            let lhs = (tokens as i128).checked_mul(total_shares);
            let rhs = (shares as i128).checked_mul(total_staked);
            if let (Some(l), Some(r)) = (lhs, rhs) {
                assert!(l <= r);
            }
            assert!(tokens <= total_staked);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stake_shares_initial_deposit() {
        let shares = calculate_stake_shares(100, 0, 0, 10).unwrap();
        assert_eq!(shares, 100);

        let err = calculate_stake_shares(5, 0, 0, 10);
        assert_eq!(err, Err(StakingError::BelowMinimumInitialStake));
    }

    #[test]
    fn test_stake_shares_pro_rata() {
        // total_staked = 200, total_shares = 100 -> 1 share = 2 tokens
        // deposit 50 tokens -> 25 shares
        let shares = calculate_stake_shares(50, 200, 100, 10).unwrap();
        assert_eq!(shares, 25);
    }

    #[test]
    fn test_unstake_tokens_pro_rata() {
        let tokens = calculate_unstake_tokens(25, 200, 100).unwrap();
        assert_eq!(tokens, 50);
    }

    #[test]
    fn test_zero_shares_rejected() {
        // total_staked = 1000, total_shares = 1 -> deposit 500 tokens -> 500 * 1 / 1000 = 0 shares
        let err = calculate_stake_shares(500, 1000, 1, 10);
        assert_eq!(err, Err(StakingError::ZeroShares));
    }
}
