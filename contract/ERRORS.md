# Inverse Arena — contract error registry & client handling

Soroban contracts signal failures with **numeric contract error codes**. Those codes surface in RPC responses (especially failed `simulateTransaction`) as host errors, for example:

```text
HostError: Error(Contract, #4)
```

A code is only unique **within one contract**: arena code `5` (`RoundNotStarted`) and factory code `5` (`InsufficientCreatorStake`) are different errors. Clients must therefore resolve an error by **(contract, code)**, never by code alone.

**Source of truth: the compiled contracts (#1597).** Each `#[contracterror]` enum is embedded in its WASM's contract spec. `contract/scripts/generate-contract-errors.mjs` decodes those specs and generates both the tables below and `frontend/src/shared/lib/stellar/contract-errors.generated.ts`. Contract CI regenerates them and fails on drift, so neither may be edited by hand. User-facing copy lives in `frontend/src/shared/lib/stellar/contract-error-registry.ts` as overrides keyed by contract and variant name; a variant without an override falls back to a generic message that names it.

```sh
cargo build --workspace --target wasm32v1-none --release   # in contract/
node contract/scripts/generate-contract-errors.mjs          # needs frontend/node_modules
```

---

## How errors reach the client

1. **Simulation** — `simulateTransaction` returns `error` (for example `HostError: Error(Contract, #4)`) plus diagnostic `events`. The frontend keeps the whole response: `StellarRpcGateway.prepareTransaction` throws a `SimulationFailedError` carrying it instead of a bare message.
2. **Submission** — Horizon / Soroban RPC may return operation-level errors (`op_underfunded`, `tx_bad_auth`, etc.).
3. **Wallet** — Signing can fail with user cancellation strings.

The app normalizes (1)–(3) through `parseContractError(error, fn, invocation?)` in `frontend/src/shared/lib/stellar/contract-error.ts`. UI layers should prefer **`parseStellarError()`** in `stellar-transactions.ts`, which delegates to the same pipeline for non-`ContractError` values so wording stays consistent.

### Which contract raised the error

A transaction invokes one contract, which may call others (the arena calls the factory, the vault and the token). `parseContractError` picks the enum as follows:

1. **Diagnostic events.** The host records an `error` diagnostic event, with topics `["error", Error(Contract, #N)]`, attributed to the contract executing when the error occurred. The earliest such event whose code matches the final error is where it originated: a contract that caught a callee's failure and returned its own error emits a later event with a different code. Its contract id is mapped to a kind through the invoked contract and the configured factory, staking, vault, oracle and token contracts.
2. **Invoking contract.** Without a matching event, the error is attributed to the contract the client invoked, which every transaction builder passes as `invocation`.
3. **Unknown.** An error from a contract the client cannot identify (for example a freshly deployed arena during `create_pool`) gets a generic message with its code, never another contract's copy.

## On-chain error codes (generated)

<!-- BEGIN GENERATED CONTRACT ERRORS (contract/scripts/generate-contract-errors.mjs) -->

### `arena` — `ArenaError`

| Code | Variant | Meaning |
| --- | --- | --- |
| 1 | `Unauthorized` | Returned when a caller attempts to perform an operation they are not authorized to perform. |
| 2 | `CannotCancelStartedGame` | Kept for on-chain backward compatibility (discriminant 2). Prefer `InvalidGameState`. |
| 3 | `NotInitialised` | Kept for on-chain backward compatibility (discriminant 3). Prefer `NotInitialized`. |
| 4 | `RoundNotActive` | Returned when a player attempts to reveal their choice before the commitment phase has ended (i.e. before the `commit_deadline` has passed), or when the admin attempts to resolve a round when the arena is not in the `Active` state. |
| 5 | `RoundNotStarted` | Returned during round resolution when no round start timestamp is recorded in storage. |
| 6 | `GracePeriodNotElapsed` | Returned when trying to resolve a round before the grace period (round duration) has not yet passed. |
| 7 | `InvalidReveal` | Returned when a player's revealed choice and salt do not match the cryptographic commitment they previously submitted. |
| 8 | `MissingCommitment` | Returned when a player attempts to reveal their choice, but they have not submitted a commitment for the current round. |
| 9 | `ChoiceAlreadyRevealed` | Returned when a player attempts to reveal their choice, but they have already successfully revealed their choice for the current round. |
| 10 | `AlreadyInitialized` | Returned when a caller attempts to call `initialize` on an arena contract that has already been initialized. |
| 11 | `GameNotFinished` | Returned when a player attempts to claim the prize, but the arena is not in the `Finished` state. |
| 12 | `PrizeAlreadyClaimed` | Returned when a player attempts to claim a prize they have already claimed, or when a payout has already been executed for this game. |
| 13 | `PlayerEliminated` | Returned when an eliminated player attempts to claim the prize or perform an action reserved for surviving players. |
| 14 | `NoPendingAdmin` | Returned when a caller attempts to accept the admin role, but there is no pending admin transfer proposal recorded. |
| 15 | `InvalidVaultAddress` | Returned when the vault address provided during initialization is invalid (e.g. not a contract or not responding to the required interface). |
| 16 | `ContractPaused` | Returned when a state-mutating gameplay entry point is called while the contract is paused by the admin (emergency circuit breaker). |
| 17 | `InvalidGameState` | Returned when the arena is in an invalid lifecycle state for the requested operation. |
| 18 | `NotInitialized` | Returned when an operation is performed on an arena that has not yet been initialized. |
| 19 | `NotEnoughPlayers` | Returned when `start_round` is called with fewer than `MIN_PLAYERS_TO_START` active players. Prevents degenerate single-player or zero-player games where one player can win trivially. |
| 20 | `PlayerBanned` | Returned when a banned player attempts to join a new arena. |
| 21 | `CreatorCannotJoin` | Returned when the arena creator/admin attempts to join their own arena. |
| 22 | `ArenaFull` | Returned when a player attempts to join after the arena has reached capacity. |
| 23 | `InvalidPlayerLimits` | Returned when configured player limits are invalid. |
| 24 | `ReentrantCall` | Returned when a guarded state-changing entry point is called again before its previous invocation has cleared the temporary reentrancy guard. |
| 25 | `RefundAlreadyClaimed` | Returned when a player attempts to claim a refund, but they have already claimed it. |
| 26 | `ArenaNotCancelled` | Returned when a player attempts to claim a refund, but the arena is not in the Cancelled state. |
| 27 | `NotAPlayer` | Returned when a player attempts to claim a refund or perform an action, but they are not registered. |
| 28 | `DeadlineTooSoon` | Returned when an operation is attempted before the required deadline has passed. |
| 29 | `AlreadyJoined` | Returned when a player who has already joined the arena tries to join again. |
| 30 | `UpgradeTimelockPending` | Returned when `execute_upgrade` is called before the timelock has elapsed after `propose_upgrade`. |
| 31 | `NoPendingUpgrade` | Returned when `execute_upgrade` is called without a prior `propose_upgrade`. |
| 32 | `InvalidEntryFee` | Returned when `initialize` is called with entry_fee <= 0. |
| 33 | `CommitPhaseEnded` | Returned when `submit_commitment` is called after the commit deadline has passed. |
| 34 | `InvalidDuration` | Returned when `initialize` or `start_round` is called with invalid duration. |
| 35 | `VaultDepositFailed` | Returned when vault deposit fails during `join_arena` or other token staking operations. The entry fee token transfer succeeded but the vault deposit did not. The contract rolls back the token transfer so no funds are left permanently locked. |
| 36 | `InvalidPlatformFee` | Returned when `update_platform_fee` is called with a value above `MAX_PLATFORM_FEE_BPS`. |
| 37 | `ArenaAlreadyStarted` | Returned by `join_arena` once at least one round has been played. |
| 38 | `InvalidLeaderboardLimit` | Returned by `configure_leaderboard_limit` when `limit` is 0 or above `MAX_LEADERBOARD_LIMIT` (#1455). Appended; existing ordinals unchanged. |
| 39 | `InvalidFreshnessPolicy` | Returned by `set_oracle_freshness_policy` when `warn_age_secs` exceeds `max_age_secs`, either is 0, or `max_age_secs` exceeds `MAX_ORACLE_MAX_AGE_SECS` (#1512). Appended; existing ordinals unchanged. |
| 40 | `StaleOracleData` | Returned by `resolve_round` when the oracle's latest observation is older than the arena's configured `max_age_secs`, or was never recorded at all (#1512). Recoverable: the admin can retry once the oracle has published a fresh observation, or raise the policy's `max_age_secs` via `set_oracle_freshness_policy` if the existing threshold is inappropriate for this arena. |
| 41 | `StartDeadlinePassed` | Returned by `join_arena` when the arena's configured start deadline has passed and the first round has not started (#1579). The lobby is closed, so entry is refused and the arena can be cancelled by anyone via `cancel_unstarted`. |
| 42 | `NoStartDeadline` | Returned by `cancel_unstarted` when this arena has no start deadline configured (#1579). Arenas deployed by a factory always have one; the explicit error keeps an unconfigured arena from being cancelled under the permissionless path. |
| 43 | `VaultWithdrawFailed` | Returned by `leave_arena` or `ban_player` when the vault cannot release the player's entry fee (#1580, #1581). The whole call reverts, so the player is neither removed nor refunded partially. |
| 44 | `GloballyPaused` | Returned by fund-moving entry points while the protocol admin has set the factory-wide emergency pause (#1583). Distinct from `ContractPaused`, which is this arena's own host-controlled pause. |
| 45 | `ArenaAlreadyHasPlayers` | Returned by `configure_player_limits` once at least one player has joined (#1640). Players joined under advertised limits, so those limits are frozen for them: a host must not lower the minimum to start with a smaller field than promised, nor the maximum below the count already present. |
| 46 | `ResolutionCursorMismatch` | Returned by `resolve_round_page` when `start` is ahead of the persisted cursor (#1639). Tallying or applying out of order would silently skip players, so the gap is refused; replaying a page at or behind the cursor is a no-op instead. |
| 47 | `ResolutionIncomplete` | Returned by `finalize_resolution` before every resolution page has been applied (#1639), or when no paged resolution has been started. |
| 48 | `ResolutionInProgress` | Returned by the one-shot `resolve_round` while a paged resolution (#1639) is in progress. Mixing the two would double-apply the round: drive the existing resolution to completion first. |

### `factory` — `FactoryError`

| Code | Variant | Meaning |
| --- | --- | --- |
| 1 | `NotInitialized` | — |
| 2 | `AlreadyInitialized` | — |
| 3 | `Unauthorized` | — |
| 4 | `InvalidStakeAmount` | — |
| 5 | `InsufficientCreatorStake` | — |
| 6 | `ArenaNotFound` | — |
| 7 | `StakeBelowMinimum` | — |
| 8 | `HostNotWhitelisted` | — |
| 9 | `WasmHashNotSet` | — |
| 10 | `PoolLimitReached` | — |
| 11 | `InvalidVault` | — |
| 12 | `InvalidOracle` | — |
| 13 | `MaxActivePoolsReached` | — |
| 14 | `PoolNotFound` | — |
| 15 | `ContractPaused` | — |
| 16 | `UnsupportedToken` | — |
| 17 | `EntryFeeTooLow` | — |
| 18 | `InvalidConfig` | — |
| 19 | `NoPendingAdmin` | — |
| 20 | `ArithmeticOverflow` | Scaling `min_stake` to a token's decimals overflowed i128 (#1361). |
| 21 | `InvalidStartDeadline` | `PoolConfig.start_deadline` was outside the allowed window relative to the creation ledger (#1579). |
| 22 | `VaultTokenMismatch` | The vault's stake token differs from `PoolConfig.stake_token`, or from the token the vault was approved with — e.g. the vault was upgraded to a different asset after approval (#1634). |
| 23 | `OracleMismatch` | `PoolConfig.oracle_contract` is not the oracle the vault accrues yield from, so the arena's yield snapshots would disagree with what the vault actually pays (#1634). |

### `fee_router` — `FeeRouterError`

| Code | Variant | Meaning |
| --- | --- | --- |
| 1 | `NotInitialized` | — |
| 2 | `AlreadyInitialized` | — |
| 3 | `Unauthorized` | — |
| 4 | `InvalidShareBps` | `staking_share_bps` exceeds `MAX_STAKING_SHARE_BPS`. |
| 5 | `BelowMinFlushAmount` | Flush amount is below `MIN_FLUSH_AMOUNT`; deferred. |
| 6 | `StakingPoolEmpty` | The staking pool holds no shares; staking portion is deferred. |
| 7 | `ArithmeticOverflow` | A checked arithmetic operation would overflow or underflow i128. |
| 8 | `NoPendingShareChange` | No pending share change has been proposed. |
| 9 | `TimelockNotExpired` | The timelock on the pending share change has not yet elapsed. |
| 10 | `NoPendingAdmin` | `new_admin` has not been proposed yet. |

### `oracle` — `OracleError`

| Code | Variant | Meaning |
| --- | --- | --- |
| 1 | `NotInitialized` | — |
| 2 | `AlreadyInitialized` | — |
| 3 | `RateTooHigh` | — |
| 4 | `NoPendingAdmin` | — |
| 5 | `DeltaTooLarge` | `\|new_rate - current_rate\| > max_delta_bps`. |
| 6 | `DelayTooLong` | `activation_delay` (or a scheduled value) exceeds the hard bound. |

### `payout` — `PayoutError`

| Code | Variant | Meaning |
| --- | --- | --- |
| 1 | `NotInitialised` | The contract has not been initialised with an admin and token. |
| 2 | `AlreadyInitialised` | `initialize` was called on an already-initialised contract. |
| 3 | `Unauthorized` | Caller is not the configured admin. |
| 4 | `AlreadyPaid` | This `(arena, recipient)` pair has already been paid (idempotency guard). |
| 5 | `InvalidAmount` | A payout amount was zero or negative. |
| 6 | `EmptyBatch` | A batch payout was submitted with no entries. |
| 8 | `InsufficientBalance` | Contract token balance is insufficient for the payout total. |
| 9 | `DuplicateRecipient` | A batch pays the same `(arena, recipient)` pair twice. |
| 10 | `BatchTooLarge` | Batch entry count exceeds the configured maximum. |
| 11 | `NoPendingAdmin` | No pending admin transfer has been proposed. |
| 14 | `ArenaSettlementUnavailable` | The arena does not answer `get_settlement` — it is not an arena, or it runs WASM older than #1632. Upgrade the arena before paying out (#1632). |
| 15 | `UnknownArena` | The factory has no record of this arena at the pool id it reports, so it was not deployed by the protocol (#1632). |
| 16 | `ArenaNotSettled` | The arena has not finished with a single winner (#1632). |
| 17 | `NotArenaWinner` | The recipient is not the arena's recorded winner (#1632). |
| 18 | `ExceedsEntitlement` | The amount exceeds the prize the arena records for its winner (#1632). |
| 19 | `DailyCapExceeded` | Paying this would push today's outflow over the daily cap (#1632). |
| 20 | `TokenMismatch` | The arena's prize is denominated in a different token from the one this contract pays out (#1632). |
| 21 | `NoPendingCap` | `apply_daily_cap` was called with no cap increase pending (#1632). |
| 22 | `CapTimelockPending` | The cap increase's timelock has not elapsed yet (#1632). |
| 23 | `InvalidCap` | A daily cap must be positive (#1632). |

### `rwa_adapter` — `RwaError`

| Code | Variant | Meaning |
| --- | --- | --- |
| 1 | `NotInitialized` | — |
| 2 | `AlreadyInitialized` | — |
| 3 | `NoDeposit` | — |
| 4 | `Unauthorized` | — |
| 5 | `AlreadyWithdrawn` | — |
| 6 | `InsufficientBalance` | — |
| 7 | `ArithmeticOverflow` | — |
| 8 | `InvalidAmount` | — |
| 9 | `NoPendingAdmin` | Returned when no admin transfer proposal is pending. |
| 10 | `NotAdmin` | Returned when a non-admin caller attempts to propose a new admin. |

### `staking` — `StakingError`

| Code | Variant | Meaning |
| --- | --- | --- |
| 1 | `NotInitialized` | — |
| 2 | `AlreadyInitialized` | — |
| 3 | `Paused` | — |
| 4 | `InvalidAmount` | — |
| 5 | `InsufficientShares` | — |
| 6 | `ZeroShares` | — |
| 7 | `BelowMinimumInitialStake` | — |
| 8 | `NoSharesOutstanding` | No shares outstanding — division by zero prevented (#1011). |
| 9 | `NoPendingAdmin` | No pending admin transfer has been proposed. |
| 10 | `ArithmeticOverflow` | A checked arithmetic operation on total_staked, total_shares, or a position's amount/shares would overflow or underflow i128 (#1362). |

<!-- END GENERATED CONTRACT ERRORS -->

## Stellar Asset Contract errors

SAC token contracts (USDC, XLM) are built into the host and have no WASM spec, so their codes are listed by hand from `soroban-env-host/src/builtin_contracts/contract_error.rs`. They surface when an arena or the factory moves tokens, attributed to the token's contract id.

| Code | Variant | Meaning |
| --- | --- | --- |
| 1 | `_Reserved1` | Reserved; the host's internal error replaced the former `InternalError` |
| 2 | `OperationNotSupportedError` | Operation not supported by the asset contract |
| 3 | `AlreadyInitializedError` | Asset contract already initialized |
| 4 | `UnauthorizedError` | Caller is not authorized |
| 5 | `AuthenticationError` | Authentication failed |
| 6 | `AccountMissingError` | Account does not exist |
| 7 | `AccountIsNotClassic` | Account is not a classic Stellar account |
| 8 | `NegativeAmountError` | Negative amount |
| 9 | `AllowanceError` | Allowance too low |
| 10 | `BalanceError` | Balance too low |
| 11 | `BalanceDeauthorizedError` | Balance not authorized by the issuer |
| 12 | `OverflowError` | Arithmetic overflow |
| 13 | `TrustlineMissingError` | Account has no trustline for the asset |
| 14 | `InsufficientAccountReserve` | Not enough XLM reserve to create the entry |
| 15 | `TooManyAccountSubentries` | Account has too many subentries |

## Host errors

`Error(<type>, <code>)` with a type other than `Contract` (`Auth`, `Budget`, `Storage`, `WasmVm`, `Value`, `Object`, `Crypto`, `Events`, `Context`) comes from the Soroban host, not from a contract enum. These are classified by type (for example `Error(Budget, ExceededLimit)` is a resource-limit failure) and never looked up in a contract table.

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

1. Wrap contract calls in `try/catch` and use **`parseContractError(err, fnName, { contractId, kind })`**, passing the contract the transaction invokes (or **`parseStellarError(err)`** for display-only).
2. For `ContractError`, show **`error.message`**; optionally log **`error.code`**, **`error.fn`**, **`error.contractError`** and **`error.cause`** for diagnostics.
3. When adding or renumbering a `#[contracterror]` variant, rebuild the WASM and run the generator in the same PR; add an override in `contract-error-registry.ts` if the variant needs user-facing copy.

---

## Review

Frontend changes that alter user-visible strings for the above codes should be reviewed by the frontend team. Rust changes that introduce or renumber codes must update this registry before merge.
