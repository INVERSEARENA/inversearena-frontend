# Arena Lifecycle Command Idempotency

This document describes the request-level idempotency layer added to `POST /api/admin/rounds/resolve`
and `POST /api/admin/rounds/:id/close`, so a duplicate or retried lifecycle command produces exactly
one durable state transition (#1386).

---

## 1. Why this exists

`RoundService.resolveRound` submits a real transaction on-chain (`submitOnChainResolve`) before the
only pre-existing concurrency guard — `RoundRepository.resolveAtomically`'s conditional `UPDATE`,
added for #1125 — ever runs. Two concurrent or retried calls for the same round both submit
independent on-chain transactions; only the second database write is rejected. `closeRound` had no
concurrency guard at all (a plain, unconditional `UPDATE`), a real TOCTOU race under load.

Neither gap was previously a stated requirement — both endpoints are manual, admin-triggered HTTP
calls with no scheduler or cron in front of them (confirmed: nothing in `src/workers/` or
`src/cache/arenaPoller.ts` calls into `RoundService`). The risk is operator double-clicks, a client
retrying after a network timeout, or a future automation client retrying against a 5xx.

## 2. Ownership

An idempotency-key row (`IdempotentCommand`) is scoped globally by `idempotencyKey` alone — there is
no per-round or per-caller partitioning beyond that. Callers are expected to mint one key per logical
action instance (e.g. `resolve-<roundId>-<attemptGroup>`), the same convention `paymentService.ts`
already establishes for payouts. The key is supplied via the `X-Idempotency-Key` request header on
both endpoints; there is no default, since a missing key means the request can never be deduplicated
— it is rejected with `400 IDEMPOTENCY_KEY_REQUIRED` rather than silently proceeding unprotected.

This is deliberately kept separate from `Round.state`: that field is coarse, shared across every
caller and every round transition, and is not a substitute for per-request dedup — it tells you
*what state the round is in*, not *whether this specific request has already run*.

## 3. State machine

```
        POST .../resolve or .../:id/close, X-Idempotency-Key: K
                            |
                            v
                    tryClaim(K)  ── unique constraint on idempotency_key ──
                       |                                    |
                  (no row for K)                     (row already exists for K)
                       |                                    |
                       v                                    v
                +-------------+                    +------------------+
                | in_progress |                     | read existing row |
                +-------------+                    +------------------+
                       |                                    |
              run the real action                +----------+----------+----------+
           (resolveRound/closeRound)              |          |          |          |
                       |                       completed  failed   in_progress  in_progress
                  success | failure           (replay    (reclaim   (fresh:     (stale, >10min:
                       |     |                  result)    + retry)  409 conflict) reclaim + retry)
                       v     v
                 completed  failed
```

- **in_progress**: claimed via `tryClaim` (an `INSERT`, rejected by the unique constraint on
  `idempotency_key` if the key already exists — this is the actual concurrency guard, not
  application-level locking).
- **completed**: the wrapped action (`resolveRound`/`closeRound`) returned successfully. The response
  body is stored verbatim (`result` JSON column) and replayed on any future request with the same key
  — the wrapped action never runs a second time for a completed key.
- **failed**: the wrapped action threw. Unlike `completed`, a `failed` row is immediately reclaimable
  by the next request with the same key (`reclaimForRetry(..., 'failed', ...)`) — a legitimate retry
  of a request that never finished must still be allowed to proceed. This preserves the retryability
  guarantee `resolveRound` already had for #1344 (a failed `get_winner`/`get_players` read must never
  strand the round in a permanently-unresolvable state): the idempotency layer sits *around* that
  guarantee, it does not weaken it.
- A stale **in_progress** row (untouched for ≥ 10 minutes — comfortably longer than
  `submitOnChainResolve`'s worst realistic confirmation-polling duration) is treated as abandoned
  (process crash, restart mid-request) and is also reclaimable, via the same `reclaimForRetry` call
  with `expectedStatus: 'in_progress'` and the staleness threshold as its age filter.
- A **fresh** in_progress row (claimed within the last 10 minutes) causes the request to be rejected
  with `409 IDEMPOTENCY_KEY_IN_PROGRESS` — a genuinely concurrent duplicate, not a retry.

## 4. Compatibility constraints

- **No response shape changes.** `resolveRound`'s and `closeRound`'s success/error response bodies
  are unchanged; the only new behavior is the `X-Idempotency-Key` header requirement and the new
  `400`/`409` failure modes it introduces.
- **`closeRound`'s underlying concurrency fix is additive, not a behavior change on the happy path.**
  `RoundRepository.closeAtomically` replaces a plain `UPDATE` with a conditional one, mirroring
  `resolveAtomically`'s existing pattern — a single, non-racing caller sees identical behavior; only
  a genuine concurrent race now fails closed instead of silently double-transitioning.
- **No new external dependency.** The idempotency store is a new Prisma model
  (`idempotent_commands`, migration `20260924084625_add_idempotent_commands`) in the same Postgres
  database already used for `Round`/`Arena`/`User` — no new vendor, no new infrastructure.
- **`txQueue.ts`/`paymentWorker.ts` are explicitly out of scope.** These belong to the server-signed
  payout pipeline (already covered by #1381's transaction-intent idempotency, a different actor and a
  different state machine — see `docs/TRANSACTION_INTENTS.md` §6), not arena lifecycle commands. They
  have zero code-level coupling to `round.controller.ts`/`roundService.ts` today (confirmed via
  grep — no round-related import in either file). Extending this work to fix
  `paymentWorker.ts`'s missing BullMQ `jobId` dedup (a real but separate, narrow gap) was a deliberate,
  disclosed exclusion, not an oversight.

## 5. Failure behavior / edge cases

| Edge case | Handling |
|---|---|
| Duplicate delivery (client resends the exact same request) | Second call replays the `completed` row's stored result; the wrapped action never re-runs. |
| Stale reads | Every lookup reads the current row fresh (`findByKey`) before deciding how to respond — no cached decision. |
| Partial failure (on-chain submit succeeds, later DB write fails) | The existing `resolveAtomically`/#1344 retryability guarantee is untouched: the round itself stays in `OPEN`/`CLOSED` so a *legitimate* retry can still complete it. The idempotency layer additionally marks the row `failed`, so a *duplicate* retry with the same key is distinguished from a brand-new request with a different key. |
| Restart during work (process crash mid-request) | A row stuck in `in_progress` past the 10-minute staleness threshold is reclaimed by the next request with the same key, rather than blocking it forever. |
| Network mismatch | Not modeled here — `submitOnChainResolve` already binds to a fixed `networkPassphrase`/`sorobanRpcUrl` from `StellarConfig` at construction time, unrelated to idempotency. |
| Maximum-size input | Unaffected — `RoundInputSchema`'s existing bounds (`playerChoices`/`allActivePlayerIds` capped at 500 entries) are unchanged; the new `X-Idempotency-Key` header is regex-validated to 8–128 characters. |
| Concurrent requests (same key, true race) | The `tryClaim` unique-constraint insert admits exactly one winner; the loser gets `409 IDEMPOTENCY_KEY_IN_PROGRESS`. Proven against a real Postgres instance in `test/integration/idempotentCommandRepository.test.ts` and `test/integration/roundLifecycleIdempotency.test.ts` (two genuinely concurrent HTTP requests via `Promise.all`), not just asserted in application logic. |

## 6. Metrics and logging

- `inversearena_lifecycle_command_outcome_total{action, outcome}` — counts every outcome
  (`executed`, `replayed`, `conflict`, `retried_after_failure`) broken down by `resolve_round` /
  `close_round`.
- `inversearena_lifecycle_command_duration_seconds{action}` — duration of a freshly-*executed*
  command (excludes replayed/conflicted requests, which don't run the underlying action).
- Structured logs via `contextLogger()` on every replay and retry-after-failure, carrying the request
  id (matching the existing `#661` convention).

See `backend/src/utils/metrics.ts` for the metric definitions and
`backend/src/services/roundService.ts`'s `runIdempotentCommand`/`executeAndRecord` for where they're
recorded.
