# Transaction Simulation Diagnostics (#1400)

## Ownership and state

`transactionDiagnosticsService.diagnoseTransaction` owns diagnostics. It
re-simulates a stored transaction's `unsignedXdr` against the current
ledger via `rpc.Server.simulateTransaction` and classifies the result into
one of three outcomes: `would_succeed`, `would_fail`, or
`restore_required`. It never submits, signs, or mutates the transaction —
this is a read-only, idempotent operation that can be called any number of
times without side effects.

`TransactionsController.diagnose` owns the HTTP boundary: it loads the
transaction through the existing `loadAccessibleTransaction` policy (the
same ownership/admin rule and opaque-404 enumeration resistance as
`getById`/`getTimeline`, see `docs/design/transaction-access.md`), then
delegates to the service and returns its result unchanged.

## Failure behavior

A simulation error from the RPC (contract panic, budget exceeded, storage
error, or a malformed/unparseable `unsignedXdr`) always produces
`would_fail`, never an HTTP error — the diagnostics endpoint's job is to
report the transaction's own health, not to fail itself because the
transaction it's diagnosing is unhealthy. Only an infrastructure failure
(RPC unreachable) or the access-policy 404 propagate as HTTP errors.

A Soroban contract panic (`Error(Contract, #N)`) is decoded into a numeric
`contractCode` and a sanitized, user-facing `remediation` string via a
backend-local copy of the panic-code registry
(`backend/src/utils/contractPanicCodes.ts`, mirroring
`frontend/src/shared-d/utils/contract-error-registry.ts` — kept as a
local copy rather than a cross-package import; see the code comment on
why). The raw RPC error string is never returned to the client, only the
extracted code and mapped message.

A simulation that succeeds but reports a `restorePreamble` — meaning some
ledger entry it depends on has expired and needs a restore footprint
before the real submission — is reported as `restore_required` with its
own remediation, distinct from both success and failure.

## Compatibility

This is a new endpoint (`POST /transactions/:id/diagnose`) with no
existing caller and no response-shape precedent to preserve; the response
is versioned (`{ version: 1, ... }`) the same way `getTimeline` already
is, so a future breaking change has room to add `version: 2` rather than
mutate the v1 shape in place.

## Observability

`inversearena_transaction_diagnostics_runs_total{outcome}` counts every
run by outcome (`would_succeed`, `would_fail`, `restore_required`,
`malformed`). `inversearena_transaction_diagnostics_duration_seconds`
records simulation latency. A structured log line
(`event: "transaction_diagnostics"`) is emitted on every completed run
with the outcome, contract code (when applicable), and latency — never
the raw RPC error text.

## Edge cases covered

- Malformed/unparseable `unsignedXdr` → `would_fail`, generic remediation.
- Unrecognized contract panic code → `would_fail`, generic
  code-included remediation rather than a crash on an unmapped code.
- Non-contract simulation error (budget, storage) → `would_fail`,
  generic remediation.
- Restore-required simulation → distinct `restore_required` outcome.
- Foreign/absent/legacy-unowned transaction → identical opaque 404,
  reusing the existing access policy; the diagnostics service is never
  invoked for a denied request.
- Diagnostics never changes the transaction's stored `status`.
