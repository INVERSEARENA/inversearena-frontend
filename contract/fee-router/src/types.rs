use soroban_sdk::{contracterror, contracttype};

/// Maximum allowed `staking_share_bps` value (100 %, i.e. all fees to stakers).
pub const MAX_STAKING_SHARE_BPS: u32 = 10_000;

/// Minimum flush amount in token base units.
///
/// Guards against dust-flush griefing: a caller who repeatedly flushes 1-unit
/// amounts burns their own XLM fee budget but also forces the staking contract
/// to process a reward epoch for a trivially small amount, which can
/// accumulate rounding loss for stakers.  Any flush below this floor is
/// deferred until the balance grows.
pub const MIN_FLUSH_AMOUNT: i128 = 1_000_000; // 0.1 token at 7 decimals

/// Timelock period (seconds) that must elapse between `propose_staking_share`
/// and `commit_staking_share`.  One week gives stakers time to react before a
/// governance change takes effect.
pub const STAKING_SHARE_TIMELOCK_SECS: u64 = 7 * 24 * 60 * 60;

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingShareChange {
    /// The proposed new value of `staking_share_bps`.
    pub new_bps: u32,
    /// Ledger timestamp after which the change may be committed.
    pub execute_after: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum FeeRouterError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    /// `staking_share_bps` exceeds `MAX_STAKING_SHARE_BPS`.
    InvalidShareBps = 4,
    /// Flush amount is below `MIN_FLUSH_AMOUNT`; deferred.
    BelowMinFlushAmount = 5,
    /// The staking pool holds no shares; staking portion is deferred.
    StakingPoolEmpty = 6,
    /// A checked arithmetic operation would overflow or underflow i128.
    ArithmeticOverflow = 7,
    /// No pending share change has been proposed.
    NoPendingShareChange = 8,
    /// The timelock on the pending share change has not yet elapsed.
    TimelockNotExpired = 9,
    /// `new_admin` has not been proposed yet.
    NoPendingAdmin = 10,
}
