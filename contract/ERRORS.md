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
