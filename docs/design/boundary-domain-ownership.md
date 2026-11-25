# Boundary and domain ownership

## Wallet lifecycle

`useStellarWallet` owns extension connection state. Only the latest connect attempt may publish a result; disconnect and network changes invalidate in-flight attempts. A network change clears the prior account rather than carrying it across networks. Passkey precedence remains a `WalletProvider` composition concern. The wallet kit currently does not provide a shared account-change event contract, so consumers should reconnect/refresh rather than treating a stale extension response as authoritative.

## Contract event decoding

The frontend parser owns typed Soroban-to-UI event conversion through a versioned registry. Missing versions are legacy v1. Unknown versions/events are dropped with a structured warning. Backend round resolution continues to read contract state directly; it does not infer protocol state from frontend event payloads.

## Transaction repository contract

`TransactionRepository` is the persistence boundary. In-memory and Mongo implementations must preserve lookups by id, idempotency key, and payout id; uniqueness for payout id, idempotency key, and `(sourceAccount, nonce)`; bounded status listing; and monotonic nonce reservation. `backend/tests/transactionRepository.conformance.test.ts` exercises the shared contract against both adapters. Mongo remains authoritative in production; the in-memory adapter is for deterministic service tests.

## Round resolution

`RoundService` owns orchestration: load/guard round state, submit Soroban resolution, read authoritative active players and winner, persist atomically, then update metrics/cache. `backend/src/domain/roundResolution.ts` owns the pure outcome projection and `backend/src/domain/settlement.ts` owns payout arithmetic. A read or projection failure occurs before persistence, so the round cannot be marked resolved with a partial result.

## Compatibility policy

The change does not alter HTTP or Soroban contract interfaces. Wallet context retains its existing public shape. Existing raw Soroban events default to decoder v1. Transaction repository identity fields are immutable after insert; mutable status and settlement metadata continue through the existing update operation. The in-memory adapter mirrors Mongo uniqueness for test behavior, while Mongo unique indexes remain the production enforcement layer.
