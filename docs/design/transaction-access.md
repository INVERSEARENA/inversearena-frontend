# Design note: transaction status access & enumeration resistance (#1454)

## Problem

`GET /api/transactions/:id` already hid foreign records behind a 404, but
`GET /api/transactions/:id/timeline` had **no ownership check at all**. Any
signed-in wallet could:

- confirm that a transaction id exists (200 vs 404),
- read every record that shared the seed's `payoutId`. `payoutId` is supplied
  by the caller, so another wallet's payout could share it and show up in the
  list.

The 404 message text was also different between the two endpoints, and each
controller used its own copy of the check.

## Ownership

`backend/src/utils/transactionAccess.ts` owns the policy. Every read or
mutation of a transaction or payout by id goes through
`loadAccessibleTransaction(repo, id, req, operation)`. That covers
`TransactionsController.getById`/`getTimeline` and
`PayoutsController.getPayout`/`signPayout`/`submitPayout`/receipts.

## Policy (fail-closed)

`evaluateTransactionAccess(record, principal)` returns a typed decision:

| Input | Decision | Client sees |
|---|---|---|
| record absent | `absent` | 404 `TRANSACTION_NOT_FOUND` |
| no authenticated principal | `unauthenticated` | 404 (the router's `requireAuth` usually answers 401 first) |
| `ownerId == null` (legacy row) and not admin | `legacy_unowned` | 404 |
| `ownerId !== user.id` | `foreign_owner` | 404 |
| admin API key | `admin` | record |
| `ownerId === user.id` | `owner` | record |

**Opaque responses.** Every denial throws `transactionNotFound(requestedId)`.
Status, code and message all come from the id the caller sent, never from the
stored record, so the responses for an absent id and a foreign id are
identical byte for byte. Both paths do exactly one `findById`, so their
timing is the same too. The timeline endpoint filters sibling records through
`filterAccessibleTransactions`. It only returns records the caller could fetch
one at a time.

## Failure behaviour

- A repository error (Mongo down) is passed on unchanged and becomes a
  generic 5xx through `errorHandler`. It is **never** turned into a 404,
  because then "store down" and "not yours" would look the same to the policy
  while telling apart states an attacker could time.
- Retrying is safe because the endpoints are read-only and idempotent.
- The malformed-id check (`TransactionIdParamSchema`) still runs before any
  lookup and returns 400. That exposes nothing about whether a record exists.

## Observability

- Metric `inversearena_transaction_access_decisions_total{operation,outcome,reason}`.
  `reason` is recorded server-side only.
- A structured log `event=transaction_access` records each decision with
  `latencyMs`. `foreign_owner` denials log at `warn` so enumeration attempts
  can be alerted on. All other decisions log at `debug`.

## Compatibility

- The REST shape is unchanged. The only visible difference is that
  `/timeline` now returns 404 for foreign seeds (before, it leaked them) and
  leaves foreign siblings out of `timeline[]`. The 404 message on `/timeline`
  now includes the id, matching `/:id`.
- `canAccessTransaction` and `assertTransactionAccess` keep their signatures.
