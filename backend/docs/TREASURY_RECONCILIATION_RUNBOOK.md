# Treasury Fee Reconciliation — Operator Runbook (#1511)

Design: `backend/docs/TREASURY_RECONCILIATION_DESIGN.md`.

## What this is

A read-only report of expected protocol platform fees (derived from each
arena's `claimed` event and the fee rate that was on-chain-configured at that
moment) versus any matching on-chain transfer. **It never moves funds** —
investigating a discrepancy here does not itself fix anything on-chain.

## Reading the report

```
GET /api/admin/treasury/reconciliation?status=discrepant&limit=50
```

(admin API key required, same auth as every other `/api/admin/*` route.)
Each row's `discrepancyType` tells you what to look at:

| discrepancyType | Meaning | First check |
|---|---|---|
| `missing_transfer` | Expected fee > 0, no matching transfer found | **Expected today** whenever an arena has a nonzero `platform_fee_bps` — see design note §1: `claim()` never sends a separate fee transfer anywhere on-chain. Not a bug unless/until fee collection is actually wired up on-chain. |
| `unexpected_transfer` | Expected fee was `0` but something was found | Should not happen under the current contract (nothing sends anything fee-shaped). If seen, escalate — it means either the classification logic or an assumption in the design note is wrong. |
| `amount_mismatch` | A transfer was found, but not for the expected amount | Re-derive `expectedAmountAtomic` by hand: `floor(yieldAmountAtomic * feeBpsApplied / 10000)` using the record's own `feeBpsApplied`/`configVersion`. Confirm against the arena's `claimed` event on a block explorer. |
| `destination_mismatch` | Amount matches, but not the destination | Check `TREASURY_DESTINATION` hasn't changed since the transfer was made, and that the record's `destination` reflects the config version active at the time. |
| `unfinalized_ledger` (status `pending`) | Too recent to judge yet, or a ledger rollback is being recovered from | Not actionable — re-check after `TREASURY_FINALITY_GRACE_SECONDS` (default 120s) has passed, or after `docs/LEDGER_ROLLBACK_RUNBOOK.md`'s recovery completes. |

## Investigating a specific record

1. `sourceTxHash` + `sourceLedgerSequence` — look the transaction up on a
   Stellar block explorer (Stellar Expert / testnet equivalent) for the
   relevant network.
2. `arenaId` is the arena contract address — `get_platform_fee_bps()` on
   that contract gives its *current* fee bps (may differ from
   `feeBpsApplied`, which is the bps that was in effect *at claim time*).
3. `configVersion` — cross-reference
   `backend/src/config/treasuryConfig.ts`'s `TREASURY_CONFIG_VERSION` history
   (git blame) if the record predates the current deployed config shape.

## Metrics and alerting

`GET /metrics` (Prometheus format):

- `inversearena_treasury_unreconciled_count{status="discrepant"}` — page if
  this grows unboundedly rather than staying roughly proportional to
  arena volume with nonzero fees configured (an unexpected step change
  suggests a new discrepancy class, not just accumulating known
  `missing_transfer` records).
- `inversearena_treasury_unreconciled_age_seconds` — page if this exceeds a
  few multiples of `TREASURY_FINALITY_GRACE_SECONDS` for a `pending` record,
  or grows without bound for `discrepant` records (nothing currently
  "resolves" a discrepant record automatically — see "Replay" below for the
  only thing that re-evaluates one).
- `inversearena_treasury_ingestion_runs_total{result="error"}` — page on any
  sustained rate; check `lastError` on the relevant
  `TreasuryReconciliationCheckpoint` row (`status: "failed"`).
- `inversearena_treasury_lease_conflicts_total` — warn only; expected
  occasionally under concurrent scheduling, but a sustained high rate means
  two schedulers are racing more than intended.

## Replay / re-running ingestion

Ingestion (`TreasuryReconciliationService.reconcileArena(arenaId, contractId, network)`)
is idempotent and safe to re-run at any time for any arena:

- Re-running from the **current checkpoint** forward picks up new events
  since the last run — this is the normal, expected operation.
- To **force a full re-scan** for one arena (e.g. after fixing a
  misconfigured `TREASURY_DESTINATION`, or to re-evaluate already-finalized
  `discrepant` records under a corrected config): delete that arena's row
  from `treasury_reconciliation_checkpoints` (`WHERE arena_id = '...' AND
  network = '...'`) and re-run. This does **not** delete existing
  `TreasuryFeeRecord` rows — they get upserted in place (same unique key),
  so history isn't lost, only recomputed.
- A `"failed"` checkpoint status (see `lastError`) does not block a fresh
  `reconcileArena` call — the checkpoint store's lease-claim path picks up
  from the last successfully committed `lastLedgerSequence` regardless of
  the failed status; failure state is informational, not a hard stop.
- There is no scheduled trigger for ingestion in this codebase yet (mirrors
  the #1382 projection's own open question in
  `docs/projection-checkpoint-replay.md` — "who calls this on a schedule?").
  Until one exists, ingestion is invoked on demand (tooling / an ops script
  calling `TreasuryReconciliationService.reconcileArena` per known arena).
  Wiring a recurring trigger is a natural, low-risk follow-up (same shape as
  that open question).

## What NOT to do

- Do not treat a `missing_transfer` discrepancy for a nonzero-fee arena as
  an incident by itself — see the table above. It becomes actionable only
  once actual on-chain fee collection exists (a separate, future change).
- Do not manually edit `TreasuryFeeRecord` rows to "fix" a discrepancy —
  they are derived, idempotently-recomputed data; a manual edit will be
  silently overwritten on the next ingestion pass for that event.
- This report never authorizes moving funds. If a genuine fee-collection gap
  needs a manual on-chain remediation, that is a separate, explicit,
  reviewed action outside this system (see the issue's "out of scope" note).
