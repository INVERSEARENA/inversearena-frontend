# Inverse Arena — contract error registry & client handling

Soroban contracts signal failures with **numeric panic / contract error codes**. Those codes surface in RPC responses (especially failed `simulateTransaction`) as host errors, for example:

```text
HostError: Error(Contract, #4)
```

The frontend must map these numbers to **user-facing copy**. This file is the **source of truth** for on-chain numeric codes. The TypeScript map `CONTRACT_PANIC_USER_MESSAGES` in `frontend/src/shared-d/utils/contract-error-registry.ts` must stay aligned with the tables below.

---

## How errors reach the client

1. **Simulation** — `Server.simulateTransaction` (or equivalent) returns an error object or message containing `HostError` / `Error(Contract, #N)`.
2. **Submission** — Horizon / Soroban RPC may return operation-level errors (`op_underfunded`, `tx_bad_auth`, etc.).
3. **Wallet** — Signing can fail with user cancellation strings.

The app normalizes (1)–(3) through `parseContractError()` in `frontend/src/shared-d/utils/contract-error.ts`. UI layers should prefer **`parseStellarError()`** in `stellar-transactions.ts`, which delegates to the same pipeline for non-`ContractError` values so wording stays consistent.

---

## On-chain numeric codes (registry)

Codes are grouped by **range** so each crate can reserve a band. Implement new variants in Rust with `#[contracterror]` (or equivalent) using **exactly** the numbers listed here, then update this document and `contract-error-registry.ts` together.

### General — `1`–`99` (any contract)

| Code | Name | Meaning (engineering) | User-facing message |
|------|------|------------------------|---------------------|
| 1 | `Unauthorized` | Caller not allowed to perform the action | You do not have permission to perform this action. |
| 2 | `InvalidInput` | Args failed validation | The supplied values are invalid. Please check them and try again. |
| 3 | `InsufficientBalance` | Token balance too low | Your balance is too low for this operation. |
| 4 | `InvalidState` | Wrong pool / game phase | This action cannot be done in the current game or pool state. |
| 5 | `AlreadyExists` | Duplicate resource | This resource already exists. |
| 6 | `NotFound` | Missing pool / record | The pool or resource could not be found. |
| 7 | `DeadlineExpired` | Time window closed | The time window for this action has closed. |
| 8 | `CapacityExceeded` | Arena / pool full | The arena has reached its maximum capacity. |

### Arena Contract — Rust `ArenaError` (`contract/arena`)

The arena contract uses `#[contracterror]` with explicit `repr(u32)` values. These are the codes emitted by `ArenaError`:

| Code | Variant | Meaning / Description | User-facing message |
|------|---------|-----------------------|---------------------|
| 1 | `Unauthorized` | Returned when a caller attempts to perform an operation they are not authorized to perform.  Note that most standard authorization checks are handled automatically by Soroban's `require_auth` mechanism, which panics rather than returning a Rust error. | You do not have permission to perform this action. |
| 2 | `CannotCancelStartedGame` | Kept for on-chain backward compatibility (discriminant 2). Prefer `InvalidGameState`. | Cannot cancel a game that has already started. |
| 3 | `NotInitialised` | Kept for on-chain backward compatibility (discriminant 3). Prefer `NotInitialized`. | This arena has not been initialized yet. |
| 4 | `RoundNotActive` | Returned when a player attempts to reveal their choice before the commitment phase has ended (i.e. before the `commit_deadline` has passed), or when the admin attempts to resolve a round when the arena is not in the `Active` state. | This action cannot be done in the current round state. |
| 5 | `RoundNotStarted` | Returned during round resolution when no round start timestamp is recorded in storage. | The round has not started yet. |
| 6 | `GracePeriodNotElapsed` | Returned when trying to resolve a round before the grace period (round duration) has not yet passed. | The grace period for this round has not elapsed yet. |
| 7 | `InvalidReveal` | Returned when a player's revealed choice and salt do not match the cryptographic commitment they previously submitted. | Your revealed choice and salt do not match your commitment. |
| 8 | `MissingCommitment` | Returned when a player attempts to reveal their choice, but they have not submitted a commitment for the current round. | You have not submitted a commitment for this round. |
| 9 | `ChoiceAlreadyRevealed` | Returned when a player attempts to reveal their choice, but they have already successfully revealed their choice for the current round. | You have already revealed your choice for this round. |
| 10 | `AlreadyInitialized` | Returned when a caller attempts to call `initialize` on an arena contract that has already been initialized. | This arena has already been initialized. |
| 11 | `GameNotFinished` | Returned when a player attempts to claim the prize, but the arena is not in the `Finished` state. | The game is not finished yet. |
| 12 | `PrizeAlreadyClaimed` | Returned when a player attempts to claim a prize they have already claimed, or when a payout has already been executed for this game. | You have already claimed your prize. |
| 13 | `PlayerEliminated` | Returned when an eliminated player attempts to claim the prize or perform an action reserved for surviving players. | You have been eliminated from this arena. |
| 14 | `NoPendingAdmin` | Returned when a caller attempts to accept the admin role, but there is no pending admin transfer proposal recorded. | There is no pending admin transfer to accept. |
| 15 | `InvalidVaultAddress` | Returned when the vault address provided during initialization is invalid (e.g. not a contract or not responding to the required interface). | The vault address provided is invalid. |
| 16 | `ContractPaused` | Returned when a state-mutating gameplay entry point is called while the contract is paused by the admin (emergency circuit breaker). | The contract is paused. State-changing actions are temporarily disabled. |
| 17 | `InvalidGameState` | Returned when the arena is in an invalid lifecycle state for the requested operation.  Examples include attempting to join or cancel an arena that is already in progress/finished, or starting a round when the game is not in a valid state. | This action cannot be performed in the current arena state. |
| 18 | `NotInitialized` | Returned when an operation is performed on an arena that has not yet been initialized. | This arena has not been initialized yet. |
| 19 | `NotEnoughPlayers` | Returned when `start_round` is called with fewer than `MIN_PLAYERS_TO_START` active players. Prevents degenerate single-player or zero-player games where one player can win trivially. | Not enough players to start a round. At least 2 active players are required. |
| 20 | `PlayerBanned` | Returned when a banned player attempts to join a new arena. | You have been banned from joining arenas. |
| 21 | `CreatorCannotJoin` | Returned when the arena creator/admin attempts to join their own arena. | You cannot join your own arena. |
| 22 | `ArenaFull` | Returned when a player attempts to join after the arena has reached capacity. | This arena is full. No more players can join. |
| 23 | `InvalidPlayerLimits` | Returned when configured player limits are invalid. | Invalid player limits configured. |
| 24 | `ReentrantCall` | Returned when a guarded state-changing entry point is called again before its previous invocation has cleared the temporary reentrancy guard. | A reentrant call was detected. Please wait for the current operation to finish. |
| 25 | `RefundAlreadyClaimed` | Returned when a player attempts to claim a refund, but they have already claimed it. | You have already claimed your refund. |
| 26 | `ArenaNotCancelled` | Returned when a player attempts to claim a refund, but the arena is not in the Cancelled state. | You can only claim a refund when the arena has been cancelled. |
| 27 | `NotAPlayer` | Returned when a player attempts to claim a refund or perform an action, but they are not registered. | You are not registered as a player in this arena. |
| 28 | `DeadlineTooSoon` | Returned when an operation is attempted before the required deadline has passed. | The required deadline has not passed yet. Please wait. |
| 29 | `AlreadyJoined` | Returned when a player who has already joined the arena tries to join again. | You have already joined this arena. |
| 30 | `UpgradeTimelockPending` | Returned when `execute_upgrade` is called before the timelock has elapsed after `propose_upgrade`. | The upgrade timelock has not elapsed yet. Please wait. |
| 31 | `NoPendingUpgrade` | Returned when `execute_upgrade` is called without a prior `propose_upgrade`. | No pending upgrade was found. Propose an upgrade first. |
| 32 | `InvalidEntryFee` | Returned when `initialize` is called with entry_fee <= 0. | The entry fee must be greater than zero. |
| 33 | `CommitPhaseEnded` | Returned when `submit_commitment` is called after the commit deadline has passed. | The commitment phase has ended. You can no longer submit choices for this round. |
| 34 | `InvalidDuration` | Returned when `initialize` or `start_round` is called with invalid duration. | Invalid round duration. Please check the duration parameter. |
| 35 | `VaultDepositFailed` | Returned when vault deposit fails during `join_arena` or other token staking operations. The entry fee token transfer succeeded but the vault deposit did not. The contract rolls back the token transfer so no funds are left permanently locked. | Vault deposit failed. The token transfer has been rolled back. |
| 36 | `InvalidPlatformFee` | Returned when `update_platform_fee` is called with a value above `MAX_PLATFORM_FEE_BPS`. | Platform fee exceeds maximum configured threshold. |
| 37 | `ArenaAlreadyStarted` | Returned by `join_arena` once at least one round has been played.  The arena returns to `Open` between rounds so `start_round` can run again, so `state == Open` alone does not mean the lobby is still recruiting. Joining after eliminations would let a latecomer buy in at the original entry fee against a thinned field. | Arena has already started; new participants cannot join. |
| 38 | `InvalidLeaderboardLimit` | Returned by `configure_leaderboard_limit` when `limit` is 0 or above `MAX_LEADERBOARD_LIMIT` (#1455). Appended; existing ordinals unchanged. | Leaderboard limit must be between 1 and 100. |
| 39 | `InvalidFreshnessPolicy` | Returned by `set_oracle_freshness_policy` when `warn_age_secs` exceeds `max_age_secs`, either is 0, or `max_age_secs` exceeds `MAX_ORACLE_MAX_AGE_SECS` (#1512). Appended; existing ordinals unchanged. | Freshness policy warning age cannot exceed maximum age. |
| 40 | `StaleOracleData` | Returned by `resolve_round` when the oracle's latest observation is older than the arena's configured `max_age_secs`, or was never recorded at all (#1512). Recoverable: the admin can retry once the oracle has published a fresh observation, or raise the policy's `max_age_secs` via `set_oracle_freshness_policy` if the existing threshold is inappropriate for this arena. | Oracle observation is stale. Retry when oracle publishes a fresh observation. |

### Factory Contract — Rust `FactoryError` (`contract/factory`)

The factory contract uses `#[contracterror]` with explicit `repr(u32)` values. These are the codes emitted by `FactoryError`:

| Code | Variant | Meaning / Description | User-facing message |
|------|---------|-----------------------|---------------------|
| 1 | `NotInitialized` | NotInitialized | Factory has not been initialized yet. |
| 2 | `AlreadyInitialized` | AlreadyInitialized | Factory is already initialized. |
| 3 | `Unauthorized` | Unauthorized | You do not have permission to perform this action. |
| 4 | `InvalidStakeAmount` | InvalidStakeAmount | Invalid stake amount. |
| 5 | `InsufficientCreatorStake` | InsufficientCreatorStake | Insufficient creator stake provided. |
| 6 | `ArenaNotFound` | ArenaNotFound | Target arena was not found. |
| 7 | `StakeBelowMinimum` | StakeBelowMinimum | Stake amount is below configured minimum threshold. |
| 8 | `HostNotWhitelisted` | HostNotWhitelisted | Host is not on the factory whitelist. |
| 9 | `WasmHashNotSet` | WasmHashNotSet | Arena WASM hash has not been configured. |
| 10 | `PoolLimitReached` | PoolLimitReached | Factory pool limit reached. |
| 11 | `InvalidVault` | InvalidVault | Invalid vault address provided. |
| 12 | `InvalidOracle` | InvalidOracle | Invalid oracle address provided. |
| 13 | `MaxActivePoolsReached` | MaxActivePoolsReached | Maximum active pools limit reached. |
| 14 | `PoolNotFound` | PoolNotFound | Pool could not be found. |
| 15 | `ContractPaused` | ContractPaused | Factory is currently paused. |
| 16 | `UnsupportedToken` | UnsupportedToken | Token is not supported for pool creation. |
| 17 | `EntryFeeTooLow` | EntryFeeTooLow | Entry fee is below minimum required threshold. |
| 18 | `InvalidConfig` | InvalidConfig | Invalid arena configuration provided. |
| 19 | `NoPendingAdmin` | NoPendingAdmin | No pending admin proposal exists. |
| 20 | `ArithmeticOverflow` | Scaling `min_stake` to a token's decimals overflowed i128 (#1361). | Stake scaling arithmetic overflowed. |

### Staking Contract — Rust `StakingError` (`contract/staking`)

The staking contract uses `#[contracterror]` with explicit `repr(u32)` values. These are the codes emitted by `StakingError`:

| Code | Variant | Meaning / Description | User-facing message |
|------|---------|-----------------------|---------------------|
| 1 | `NotInitialized` | NotInitialized | Staking is not available yet. |
| 2 | `AlreadyInitialized` | AlreadyInitialized | Staking is already set up. |
| 3 | `Paused` | Paused | Staking is temporarily unavailable. |
| 4 | `InvalidAmount` | InvalidAmount | Enter an amount greater than zero. |
| 5 | `InsufficientShares` | InsufficientShares | You do not have that many shares to unstake. |
| 6 | `ZeroShares` | ZeroShares | This deposit is too small for the current pool value. Stake more. |
| 7 | `BelowMinimumInitialStake` | BelowMinimumInitialStake | The first deposit must be at least the minimum initial stake. |
| 8 | `NoSharesOutstanding` | No shares outstanding — division by zero prevented (#1011). | No shares outstanding in the staking pool. |
| 9 | `NoPendingAdmin` | No pending admin transfer has been proposed. | No pending admin transfer has been proposed. |
| 10 | `ArithmeticOverflow` | A checked arithmetic operation on total_staked, total_shares, or a position's amount/shares would overflow or underflow i128 (#1362). | Staking arithmetic calculation overflowed. |

### Payout Contract — Rust `PayoutError` (`contract/payout`)

The payout contract uses `#[contracterror]` with explicit `repr(u32)` values. These are the codes emitted by `PayoutError`:

| Code | Variant | Meaning / Description | User-facing message |
|------|---------|-----------------------|---------------------|
| 1 | `NotInitialised` | The contract has not been initialised with an admin and token. | Payout contract is not initialized. |
| 2 | `AlreadyInitialised` | `initialize` was called on an already-initialised contract. | Payout contract is already initialized. |
| 3 | `Unauthorized` | Caller is not the configured admin. | You do not have permission to execute payouts. |
| 4 | `AlreadyPaid` | A payout with this id has already been executed (idempotency guard). | A payout with this identifier has already been executed. |
| 5 | `InvalidAmount` | A payout amount was zero or negative. | Payout amount is invalid. |
| 6 | `EmptyBatch` | A batch payout was submitted with no recipients. | Batch payout contains no recipients. |
| 8 | `InsufficientBalance` | Contract token balance is insufficient for the payout total. | Contract balance is insufficient for this payout. |
| 9 | `DuplicateRecipient` | A batch contains duplicate recipient addresses. | Batch contains duplicate recipient addresses. |
| 10 | `BatchTooLarge` | Batch recipient count exceeds the configured maximum. | Batch recipient count exceeds maximum allowable limit. |
| 11 | `NoPendingAdmin` | No pending admin transfer has been proposed. | No pending admin transfer has been proposed. |
| 12 | `DestinationMismatch` | `distribute_winnings` was called with a destination that does not match the address pre-registered by `register_destination`. Issue #1450 — payout destination binding. | Payout recipient does not match pre-registered destination address. |
| 13 | `DestinationNotRegistered` | `distribute_winnings` was called for a payout_id that has no registered destination. Call `register_destination` first. Issue #1450 — payout destination binding. | No destination has been registered for this payout id. |

### RWA Adapter Contract — Rust `RwaError` (`contract/rwa-adapter`)

The rwa-adapter contract uses `#[contracterror]` with explicit `repr(u32)` values. These are the codes emitted by `RwaError`:

| Code | Variant | Meaning / Description | User-facing message |
|------|---------|-----------------------|---------------------|
| 1 | `NotInitialized` | NotInitialized | RWA Adapter is not initialized. |
| 2 | `AlreadyInitialized` | AlreadyInitialized | RWA Adapter is already initialized. |
| 3 | `NoDeposit` | NoDeposit | No active deposit found for caller. |
| 4 | `Unauthorized` | Unauthorized | Caller is not authorized. |
| 5 | `AlreadyWithdrawn` | AlreadyWithdrawn | Deposit has already been withdrawn. |
| 6 | `InsufficientBalance` | InsufficientBalance | Insufficient vault balance. |
| 7 | `ArithmeticOverflow` | ArithmeticOverflow | Yield rate calculation overflowed. |
| 8 | `InvalidAmount` | InvalidAmount | Invalid amount provided. |
| 9 | `NoPendingAdmin` | Returned when no admin transfer proposal is pending. | No pending admin transfer has been proposed. |
| 10 | `NotAdmin` | Returned when a non-admin caller attempts to propose a new admin. | Caller is not an admin. |

### Oracle Contract — Rust `OracleError` (`contract/oracle`)

The oracle contract uses `#[contracterror]` with explicit `repr(u32)` values. These are the codes emitted by `OracleError`:

| Code | Variant | Meaning / Description | User-facing message |
|------|---------|-----------------------|---------------------|
| 1 | `NotInitialized` | NotInitialized | Oracle is not initialized. |
| 2 | `AlreadyInitialized` | AlreadyInitialized | Oracle is already initialized. |
| 3 | `RateTooHigh` | RateTooHigh | Yield rate exceeds configured maximum basis points. |
| 4 | `NoPendingAdmin` | NoPendingAdmin | No pending admin transfer has been proposed. |

---

## Infrastructure / network errors (non-contract codes)

These are **not** WASM contract panics; they come from Horizon, RPC, or the wallet. The frontend maps them to `ContractErrorCode` string enums in `contract-error.ts` (e.g. `BAD_AUTH`, `INSUFFICIENT_FUNDS`). Keep user-facing defaults in `DEFAULT_MESSAGES` there so they match product copy.

| Pattern / source | `ContractErrorCode` | Default user message (summary) |
|--------------------|---------------------|--------------------------------|
| `tx_bad_auth` | `BAD_AUTH` | Wallet / signature problem |
| `op_underfunded`, “insufficient” | `INSUFFICIENT_FUNDS` | Balance too low |
| `tx_too_late` | `TRANSACTION_TIMEOUT` | Transaction expired |
| User rejected / cancelled | `USER_REJECTED` | User cancelled |
| Zod / validation | `VALIDATION_FAILED` | Invalid input |
| Simulation / `HostError` | `SIMULATION_FAILED` | Simulation failed (detail may include on-chain code) |
| Account 404 | `ACCOUNT_NOT_FOUND` | Fund the account |

---

## Frontend checklist

1. Wrap contract calls in `try/catch` and use **`parseContractError(err, fnName)`** (or **`parseStellarError(err)`** for display-only).
2. For `ContractError`, show **`error.message`**; optionally log **`error.code`**, **`error.fn`**, and **`error.cause`** for diagnostics.
3. When adding a Rust `ContractError` variant, **update this file and `contract-error-registry.ts` in the same PR**.

---

## Review

Frontend changes that alter user-visible strings for the above codes should be reviewed by the frontend team. Rust changes that introduce or renumber codes must update this registry before merge.
