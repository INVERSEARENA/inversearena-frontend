# Admin Maintenance Windows (#1399)

## Ownership

- **MaintenanceService** (`src/services/maintenanceService.ts`) owns the
  ledger-boundary state machine: schedule, cancel, list, and the single
  `getStatus()` both the public status endpoint and the mutation guard share.
- **AdminController** owns *authorization*: scheduling/cancelling require
  admin auth (`ApiKeyAuthProvider`) plus a single-use confirmation token
  (same pattern as `forceResolveTransaction`/`resubmitTransaction`), and both
  actions are audit-logged.
- **ledgerClock** (`src/services/ledgerClock.ts`, shared with #1408) owns
  reading the current Soroban ledger sequence, cached 5s and routed through
  the shared circuit breaker.

## State transitions

Status is **derived on every read**, never persisted, from
`(startLedgerSequence, endLedgerSequence, cancelledAt, currentLedger)`:

```
scheduled -> active     when currentLedger >= startLedgerSequence
active    -> completed  when endLedgerSequence is set and currentLedger >= it
(any)     -> cancelled  terminal, set explicitly via DELETE /api/admin/maintenance/:id
```

An indefinite window (`endLedgerSequence: null`) never auto-completes — it
must be cancelled. There is no background job that flips a status column, so
there is nothing that can fall behind or race a concurrent cancel.

## Failure behavior

`maintenanceGuard` (`src/middleware/maintenance.ts`) sits ahead of every
route. Safe methods (GET/HEAD/OPTIONS) and `/api/admin`, `/api/auth`,
`/api/maintenance` always pass through — admins can still manage the window
that's blocking everyone else, and nobody is locked out of their account.
Every other mutating request is rejected with `503 MAINTENANCE_MODE` while a
window is active.

If the ledger clock itself fails (Soroban RPC outage), the guard **fails
closed** — the same 503 the rest of the app already returns for a Soroban
outage. This isn't a new failure mode: most mutating game actions already
require a live Soroban read/write to do anything.

## Compatibility

Fully additive: three new admin endpoints
(`POST`/`DELETE`/`GET /api/admin/maintenance`), one new public endpoint
(`GET /api/maintenance/status`), and a new always-mounted guard middleware
that is a no-op unless a window is active. No existing endpoint's request or
response shape changes.

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/admin/maintenance` | admin + confirmation token | `{ startLedgerSequence, endLedgerSequence?, reason }` |
| `DELETE` | `/api/admin/maintenance/:id` | admin + confirmation token | 409 if already cancelled/completed |
| `GET` | `/api/admin/maintenance` | admin | Full history |
| `GET` | `/api/maintenance/status` | none | `{ active, currentLedgerSequence, window }` |

## Metrics / logs

- `inversearena_maintenance_mutations_blocked_total{method}` — counter, incremented per blocked mutation.
- `inversearena_maintenance_windows_scheduled_total{status}` — counter, `success`/`failed`.
- Structured `logger.warn` on every blocked mutation and every degraded-to-cache fallback.
- Every schedule/cancel attempt is written to the existing admin audit log (`AdminService.log`).
