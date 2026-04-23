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

### Factory — `100`–`199`

| Code | Name | Meaning | User-facing message |
|------|------|---------|---------------------|
| 100 | `InvalidStakeForPool` | Stake rules not met | Stake amount does not meet the rules for creating a pool. |
| 101 | `UnsupportedToken` | Token not whitelisted | This token is not supported for pool creation. |

### Factory contract — Rust `Error` (`contract/factory`)

The factory contract uses `#[contracterror]` with explicit `repr(u32)` values. These are the codes emitted by `FactoryContract`:

| Code | Variant | Meaning |
|------|---------|---------|
| 1 | `NotInitialized` | `initialize` not called |
| 2 | `AlreadyInitialized` | `initialize` called twice |
| 3 | `Unauthorized` | Caller lacks permission |
| 4 | `NoPendingUpgrade` | No upgrade proposal exists |
| 5 | `TimelockNotExpired` | Upgrade timelock not elapsed |
| 6 | `StakeBelowMinimum` | Stake below configured minimum |
| 7 | `HostNotWhitelisted` | Caller not on host whitelist |
| 8 | `InvalidStakeAmount` | Stake is zero or negative |
| 9 | `PoolAlreadyExists` | Duplicate pool_id |
| 10 | `InvalidCapacity` | Capacity out of range |
| 11 | `WasmHashNotSet` | Arena WASM hash not configured |
| 12 | `MalformedUpgradeState` | Partial upgrade state |
| 13 | `UnsupportedToken` | Token not approved |
| 14 | `UpgradeAlreadyPending` | Duplicate upgrade proposal |
| 15 | `Paused` | Contract paused |
| 16 | `ArenaNotFound` | Arena not registered |
| 17 | `NotWhitelisted` | Player not on private arena whitelist |

### Arena (pool) — `200`–`299`

| Code | Name | Meaning | User-facing message |
|------|------|---------|---------------------|
| 200 | `NotJoined` | User not in pool | You need to join this arena before doing that. |
| 201 | `AlreadySubmitted` | Choice already sent | You have already submitted a choice for this round. |
| 202 | `InvalidRound` | Round mismatch | This round is not valid for the current game. |
| 203 | `ChoiceNotOpen` | Not accepting choices | Choices are not being accepted right now. |
| 204 | `NothingToClaim` | No payout | There is nothing to claim right now. |

### Staking — `300`–`399`

| Code | Name | Meaning | User-facing message |
|------|------|---------|---------------------|
| 300 | `StakeAmountInvalid` | Bad stake amount | Stake amount is invalid. |
| 301 | `StakingPaused` | Staking disabled | Staking is temporarily unavailable. |

### Payout — `400`–`499`

| Code | Name | Meaning | User-facing message |
|------|------|---------|---------------------|
| 400 | `PayoutNotReady` | Payout not available | Payout is not available yet. |

### Unassigned codes

Any number **not** listed above should be treated as **unknown** on the client: show a generic message and include `(on-chain code N)` for support. When adding a new code, assign the next free slot in the correct range and update both this file and `contract-error-registry.ts`.

### Arena contract — Rust `ArenaError` (`contract/arena`)

The arena pool contract uses `#[contracterror]` with **explicit** `repr(u32)` values (not the 200–299 band above). These are the codes emitted by `ArenaContract`:

| Code | Variant | Meaning |
|------|---------|---------|
| 1 | `AlreadyInitialized` | `init` called twice |
| 2 | `InvalidRoundSpeed` | Zero round speed |
| 3 | `RoundAlreadyActive` | `start_round` while a round is open |
| 4 | `NoActiveRound` | Operation requires an active round |
| 5 | `SubmissionWindowClosed` | Past deadline |
| 6 | `SubmissionAlreadyExists` | Duplicate submission |
| 7 | `RoundStillOpen` | `timeout_round` before deadline |
| 8 | `RoundDeadlineOverflow` | Ledger math overflow / round mismatch |
| 9 | `NotInitialized` | Missing `init` |
| 10 | `Paused` | Contract paused |
| 11 | `ArenaFull` | Participant cap (admin capacity or hard bound) |
| 12 | `AlreadyJoined` | Duplicate `join` |
| 13 | `InvalidAmount` | Non-positive stake |
| 14 | `NoPrizeToClaim` | No winner record |
| 15 | `AlreadyClaimed` | `claim` already used |
| 16 | `ReentrancyGuard` | Reserved |
| 17 | `NotASurvivor` | Reserved |
| 18 | `GameAlreadyFinished` | Game ended |
| 19 | `TokenNotSet` | Token not configured |
| 20 | `MaxSubmissionsPerRound` | Per-round submission bound (`contract/BOUNDS.md`) |
| 21 | `PlayerEliminated` | Eliminated player attempted action |
| 42 | `NotWhitelisted` | Non-whitelisted player attempted to join a private arena |
| 22 | `WrongRoundNumber` | Submitted for wrong round |
| 23 | `NotEnoughPlayers` | Too few players to start/resolve round |
| 24 | `InvalidCapacity` | `set_capacity` value out of `[MIN, MAX]` range |
| 25 | `NoPendingUpgrade` | `execute_upgrade`/`cancel_upgrade` with no proposal |
| 26 | `TimelockNotExpired` | `execute_upgrade` called before 48-hour timelock |

**ABI snapshot:** `contract/arena/abi_snapshot.json` guards these ordinals in CI (`abi_guard` tests).

> **Required process — every new `ArenaError` variant must be added in the same PR to all three places:**
> 1. `contract/arena/src/lib.rs` — add the variant with its explicit `repr(u32)` value.
> 2. `contract/arena/abi_snapshot.json` — add `"VariantName": N` to the `arena_error` object.
> 3. `contract/arena/src/abi_guard.rs` — add `("VariantName", ArenaError::VariantName)` to the `pairs` slice.
>
> Omitting any of the three lets `cargo test` pass while the snapshot is stale, providing false safety for downstream consumers that branch on error codes.

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
