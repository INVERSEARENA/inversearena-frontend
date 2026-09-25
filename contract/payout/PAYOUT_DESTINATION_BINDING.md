# Payout Destination Binding — Issue #1450

## Ownership

- **Contract layer** — `contract/payout/src/lib.rs`, `storage.rs`, `types.rs`
- **Backend layer** — `backend/src/services/paymentService.ts`
  (`assertSignedTransactionMatches` already enforces the destination at XDR
  verification time; no new backend changes are required by this issue)

## Problem

`distribute_winnings(payout_id, winner, amount)` previously accepted any
`winner` address the admin supplied at call time. A compromised admin key
could therefore redirect a payout to an arbitrary address — even after the
legitimate winner had been confirmed off-chain.

## Solution

A two-step protocol is now enforced for `distribute_winnings`:

1. **Register** — the admin calls `register_destination(payout_id, destination)`
   to bind a payout_id to a specific recipient address. This stores a
   `DataKey::Destination(payout_id) → Address` entry in persistent storage.
2. **Distribute** — `distribute_winnings` looks up the stored binding and
   rejects the call with `DestinationMismatch` or `DestinationNotRegistered`
   if the caller-supplied `winner` does not match.

`distribute_batch` is unaffected: it carries recipients inline in the call
arguments and is already subject to the `AlreadyPaid` idempotency guard.

## State transitions

```
              register_destination(id, addr)
unregistered ─────────────────────────────► bound(addr)
                                                 │
                                    distribute_winnings(id, addr, amount)
                                                 │
                                                 ▼
                                            paid(addr)
```

- An attempt to register a second destination for the same `payout_id` is
  silently ignored — the first binding is immutable once written.
- Once `distribute_winnings` succeeds the `Paid(id)` flag is set and the
  destination binding remains in storage for off-chain auditing via
  `get_destination`.

## Failure behaviour

| Condition | Error | Funds moved? |
|-----------|-------|--------------|
| No `register_destination` called | `DestinationNotRegistered` | No |
| `winner ≠ registered address` | `DestinationMismatch` | No |
| `payout_id` already paid | `AlreadyPaid` | No |

## Compatibility

- The new `register_destination` entry point is additive; no existing storage
  keys or function signatures are changed.
- Error discriminants 12 and 13 are new; existing clients that do not know
  these codes will still receive a typed contract error (not a panic).
- The backend `assertSignedTransactionMatches` already checks the destination
  inside the signed XDR; this contract-level check adds a second, independent
  enforcement layer with no backend code changes required.

## Observability

`register_destination` emits a `dst_reg` event carrying `(payout_id,
destination)` so off-chain indexers can confirm bindings without querying
contract storage directly.
