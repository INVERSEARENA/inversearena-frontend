# Payout batch planning (#1620)

`distribute_batch` in `contract/payout` pays up to `MAX_BATCH_SIZE` (50)
recipients in one transaction. A fixed cap ignores real resource use: a transfer
to a new account costs more than one to an existing trustline, so a fixed batch
either fails simulation near the limits or leaves capacity unused.

`backend/src/services/payoutBatchPlanner.ts` sizes batches from simulation:

1. For each batch, simulate the largest candidate size (up to the cap).
2. If it does not fit, bisect between a known-fitting and a known-failing size.
3. A fit means every simulated resource is within `headroom` of its limit
   (default `0.8`).
4. A simulation error counts as "does not fit", so the batch shrinks.
5. A recipient that does not fit even alone is reported as `unplannable` and
   skipped, so it cannot block the rest.

## Drift between plan and submit

Simulated usage can drift between planning and submission. `shrinkOnDrift`
halves a batch that fails at submit time, and the caller re-simulates the
smaller batch.

## Metrics

`summarizePlan` reports the two numbers the planner is meant to move:

- `recipientsPerTransaction`
- `feePerRecipientStroops` (total minimum resource fee divided by recipients)

## Status

The planner is implemented and unit-tested with an injected simulator. It is
not yet wired into a submission path, because the backend does not currently
submit batched payouts (`paymentService` submits single `distribute_winnings`
calls). Wiring it in needs a real `simulateTransaction` adapter as the
`BatchSimulator`.

## Contract change

`distribute_batch` detects duplicate `(arena, recipient)` pairs with a `Map`
instead of `Vec::contains`, which is O(n) rather than O(n²). Behaviour is
unchanged: a duplicate still returns `DuplicateRecipient`.
