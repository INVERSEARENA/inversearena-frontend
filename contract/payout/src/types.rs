use soroban_sdk::contracterror;

/// Error codes returned by the payout contract.
#[contracterror]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutError {
    /// The contract has not been initialised with an admin and token.
    NotInitialised = 1,
    /// `initialize` was called on an already-initialised contract.
    AlreadyInitialised = 2,
    /// Caller is not the configured admin.
    Unauthorized = 3,
    /// A payout with this id has already been executed (idempotency guard).
    AlreadyPaid = 4,
    /// A payout amount was zero or negative.
    InvalidAmount = 5,
    /// A batch payout was submitted with no recipients.
    EmptyBatch = 6,
}
