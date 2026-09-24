# Deterministic Client Reconciliation after Soroban Confirmation (#1385)

## Overview

Inverse Arena coordinates wallet clients, an asynchronous API, background
workers, and Soroban contracts. The client sends a signed transaction and must,
after confirmation, converge any optimistic/local UI state to the chain's
authoritative state. This document defines the ownership, state transitions,
failure behavior, and compatibility constraints of the single enforced
implementation of that capability.

**Ownership:** `frontend/src/shared-d/utils/stellar-transactions.ts` owns the
reconciliation engine (`captureTransactionOutcome`, `reconcileTransaction`).
`frontend/src/features/arena/useArenaState.ts` owns the chain-state convergence
surface (`reconcile(publicKey)`, `lastSyncedAt`). Consumers never re-implement
"what happens after a transaction confirms" — they map errors to an outcome and
call `reconcileTransaction`, then converge their UI through the hook.

## State transitions

```
 submitSignedTransaction
        │
        ├─ returns tx result ──────────────► outcome SUCCESS  ──► CONFIRMED (source: rpc, 0 retries)
        │
        └─ throws ContractError ──► captureTransactionOutcome()
                                      ├─ TRANSACTION_TIMEOUT + hash ──► outcome TIMEOUT
                                      └─ any other error ─────────────► outcome REJECTED (reason = error code)

 reconcileTransaction(outcome)
   SUCCESS  ───────────────────────────────► resolved CONFIRMED   (deterministic, no network)
   REJECTED (with or without hash) ────────► resolved REJECTED    (terminal failure is authoritative)
   TIMEOUT  ──► poll Horizon (reconcilePendingTransaction)
                  SUCCESS ─► CONFIRMED │ FAILED ─► REJECTED │ exhausted ─► UNKNOWN

 UNKNOWN is "still unknown", never a hard failure (#1135 semantics):
 it must not be rendered as a failure and the normal polling path will converge later.
```

Every input maps to exactly one outcome and every outcome maps to exactly one
terminal `ReconcileStatus`. There is no branching on timing, deployment state,
or caller assumptions.

## Failure behavior

| Failure mode | Behavior |
|---|---|
| Initial submission rejected by network | `captureTransactionOutcome` → `REJECTED`; reconciliation resolves immediately (`source: rpc`). |
| RPC confirmation polling times out | `TRANSACTION_TIMEOUT` → `TIMEOUT`; reconciliation retries via Horizon. |
| Horizon lists the tx as failed | Resolution is `REJECTED`. |
| Horizon never sees the tx within `maxAttempts` | Resolution is `UNKNOWN` — callers keep the last known state and let polling converge later. |
| Horizon fetch-level error | Treated as `NOT_FOUND` for that attempt (same as #1135) and retried. |
| Invalid hash (missing / under-minimum / over max-size) | `VALIDATION_FAILED` `ContractError` is thrown before any state transition. |
| Duplicate delivery of an already-resolved hash | Returns the cached terminal result (idempotent). |
| Concurrent requests for the same hash | Share one in-flight resolution. |
| Restart during work | The in-memory cache is lost; a fresh `reconcile()` (or the polls) re-reads the chain and reconverges. |

## Observability

`reconcileTransaction` accepts an injectable `eventSink` (default:
`console.info("[client-reconciliation] …")`), emitting one JSON object per
terminal resolution and per Horizon retry:

- `success` — resolution is `CONFIRMED`
- `failure` — resolution is `REJECTED` (carries `reason`)
- `retry` — one per Horizon 404 poll (`retries` counts attempts)
- `timeout` — resolution is `UNKNOWN` after `maxAttempts`

Every event records `hash`, `outcome`, `resolved`, `retries`, `latencyMs`,
`source` (`rpc` | `horizon`), and optional `arenaId` correlation.

## Compatibility constraints

- **Existing public behavior is preserved.** `submitSignedTransaction`,
  `checkTransactionOnHorizon`, and `reconcilePendingTransaction` are unchanged;
  `reconcilePendingTransaction` remains the low-level Horizon bus the engine
  drives.
- **No API / contract / storage / event version changes.** REST and Soroban
  compatibility are untouched; the engine only reads Horizon and re-reads the
  chain via the existing `fetchArenaState` path.
- **`useArenaState` is extended, not changed:** `lastSyncedAt` and
  `reconcile()` are additive. Existing consumers of `state`/`health` are
  unaffected.
- **REST and Soroban compatibility:** the reconcile read uses the same
  `fetchArenaState(arenaId, publicKey)` call the poll loop already uses.

## Convergence contract for consumers

After a transaction's confirmation is reconciled, consumers converge their
optimistic UI to chain state:

```ts
const outcome = captureTransactionOutcome(error);       // or SUCCESS
const { resolved } = await reconcileTransaction(outcome, { arenaId });
if (resolved === "CONFIRMED" || resolved === "REJECTED") {
  await reconcileArenaId.reconcile(walletAddress);        // hook: re-reads chain
}
// UNKNOWN: keep last known state; the hook's polling will converge later.
```

The arena page (`src/app/arena/page.tsx`) is wired to this contract for JOIN /
COMMIT / REVEAL / CLAIM: on SUCCESS, REJECTED, and TIMEOUT it resolves the
outcome through the engine and then re-reads the authoritative chain state, so
optimistic `isJoined` / `hasCommittedForRound` never outlive the chain.

## Developer integration notes

- Run engine tests: `pnpm exec jest stellar-transactions.reconciliation`
- Run hook + integration coverage: `pnpm exec jest useArenaState.reconcile reconciliation.integration`
- Full frontend suite: `pnpm exec jest`; typecheck with `pnpm exec tsc --noEmit`.