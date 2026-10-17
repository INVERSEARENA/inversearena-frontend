# Ledger Rollback Detection and Recovery (#1490)

`services/ledgerContinuity.ts` keeps a window (128) of observed `(sequence, hash)`
ledger identities, fed by every fresh read in `ledgerClock`. Each observation is
classified: `advanced`, `unchanged`, `lagging` (older ledger whose hash we
retained: a slow RPC provider, ignored), `regression` (older, unretained
sequence), `conflict` (retained sequence, different hash) or `gap` (jump larger
than the window; window re-anchored, caches invalidated, no quarantine). An RPC
endpoint switch needs no special case: a provider that is behind is `lagging`,
one on another fork is a `conflict`.

## Recovery

On `regression`/`conflict` the window is truncated to the **safe checkpoint**,
the highest retained ledger below the observed sequence (`null` when the
rollback is deeper than the window), reads are quarantined and `arena:stats:*`
and `arena:onchain-snapshot:*` are deleted (nothing else is derived from arena
ledger reads). While quarantined:

- the arena poller publishes nothing; afterwards it drops baselines and replay
  history and publishes a fresh snapshot (its sequence counter is kept, so
  client cursors stay monotonic);
- the transaction reconciler defers confirmation jobs (`moveToDelayed` +
  `DelayedError`, so no retry attempt is consumed);
- `GET /api/arenas/:id/stats` skips the live read, caches nothing and returns
  `degraded: true` with database values and `ledgerSequence: null`, with no RPC
  details.

Recovery ends after two further observations advance consistently. State is
persisted in Redis (`ledger:continuity:<network passphrase>`), so a restart
during recovery stays quarantined.

## Metrics and logs

`inversearena_ledger_rollback_depth_ledgers`,
`inversearena_ledger_rollback_recovery_duration_seconds`,
`inversearena_ledger_rollback_affected_consumers_total{consumer}`. Log events:
`ledger_rollback_detected`, `ledger_continuity_gap`,
`ledger_rollback_consumers_notified`, `ledger_rollback_recovered`,
`tx_reconciler_deferred`.

## Alerting

- Page on `ledger_rollback_detected` logs not followed by `ledger_rollback_recovered` within 5 minutes.
- Warn on any `increase(inversearena_ledger_rollback_depth_ledgers_count[15m]) > 0`.

## Manual recovery

1. Check `SOROBAN_RPC_URL`; a provider on a minority fork is the usual cause of a `conflict`. Point it at a healthy provider and restart: recovery resumes from the persisted state.
2. To force a fresh start after verifying out of band, delete the Redis key above and restart. The window re-anchors on the next observation.
3. Confirm `/api/arenas/:id/stats` no longer reports `degraded: true`.

Limit: `getLatestLedger` has no parent hash, so the common point is the highest
retained sequence below the observed one, not a hash-chain proof.
