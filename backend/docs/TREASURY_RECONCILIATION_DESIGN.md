# Protocol Treasury Accounting & Fee Reconciliation — Design Note

Issue: #1511 "Implement protocol treasury accounting and fee reconciliation"

This note defines a read-only reconciliation service that derives expected
protocol fees from authoritative on-chain arena outcomes and reports whether
actual on-chain movement matches, without moving funds or changing fee
percentages (both explicitly out of scope for this issue).

## 1. Background: there is currently no on-chain fee transfer at all

`contract/arena/src/lib.rs`'s `claim()` transfers the full
`principal + total_yield` to the winner in **one** token transfer:

```rust
let token_client = token::TokenClient::new(&env, &config.stake_token);
token_client.transfer(&arena_addr, &winner, &total);
ArenaEvents::prize_claimed(&env, &winner, total, total.saturating_sub(principal));
```

`ArenaConfig.platform_fee_bps` (settable via `update_platform_fee`) is
accounting metadata only; nothing in the contract deducts it or sends it
anywhere. There is also no treasury/fee-destination address concept anywhere
in `contract/` — no `treasury`/`fee_wallet`/`fee_recipient` field on any
contract.

This means: whenever an arena's configured fee is nonzero, this service's
"expected fee" will **always** reconcile as `missing_transfer` — there is
structurally no other transfer for it to find. This is not a bug in the
reconciliation service; it is an accurate, valuable finding the service
exists to surface (the protocol has configured a fee with no working
collection mechanism yet). Wiring an actual on-chain fee transfer is
explicitly out of scope for #1511 ("Out of scope: Moving treasury funds or
changing fee percentages").

`backend/src/domain/settlement.ts`'s `computeSettlementBreakdown` computes
its own `platformFee` from `process.env.PLATFORM_FEE_BPS` — a **second**,
independent, unversioned fee-bps source, distinct from the arena contract's
own `platform_fee_bps`. This service deliberately does **not** use that
value for its "expected" calculation — see §3.

## 2. The #1382 event projection cannot be reused (flagged, not fixed here)

`backend/src/services/projection/` (arena event projection/replay/checkpoint,
built for #1382) was the natural place to source on-chain events from. It
turns out to be non-functional against the real contract: `arenaEventTypes.ts`'s
`ARENA_EVENT_TOPICS` (`INIT`, `CFGD`, `START`, `FINISH`, `JOIN`, `CHOICE`,
`ELIM`, `CLAIMED`, `RWAYLD` — all uppercase) does not match any topic the
deployed contract actually emits. `contract/arena/src/events.rs` publishes
lowercase topics via `symbol_short!(...)`: `"init"`, `"join"`, `"commit"`,
`"reveal"`, `"resolved"`/`"rslvd2"`, `"elim"`, `"finished"`, `"claimed"`,
`"fee_upd"`, etc. — several of which (`"resolved"`, `"fee_upd"`, `"commit"`,
`"reveal"`) have no case in `ARENA_EVENT_TOPICS` at all.
`onChainReader.toArenaProjectionEvent`'s `isArenaEventTopic` check is an
exact string match with no case-folding or translation, so every real event
decodes as `ArenaUnknownEvent`. `docs/event-schema.md` (the doc that subsystem
is built against) itself describes functions that don't exist in the current
contract (`finish_game()`, `submit_choice()`, `receive_rwa_yield()`), i.e. it
predates the current commit-reveal architecture.

This is a separate, larger pre-existing issue — fixing it means rewriting the
topic list, adding decoders for the real payload shapes, re-verifying the
fold's equivalence tests, and updating two docs. That is out of scope for a
treasury-reconciliation issue and was **not** attempted here (confirmed with
the repo owner before proceeding). Instead:

- `backend/src/domain/treasuryEventDecoder.ts` is a small, independent, and
  *correctly* topic-matched decoder for only the two real topics this feature
  needs: `"claimed"` and `"fee_upd"`. It does not touch, import, or claim to
  fix `arenaEventTypes.ts`/`arenaProjectionFold.ts`.
- `backend/src/services/treasury/treasuryEventReader.ts` is the thin RPC
  fetch/pagination wrapper around that decoder (mirrors
  `onChainReader.getArenaEvents`'s pagination contract).

## 3. Where "expected fee" comes from

`ArenaEvents::prize_claimed` (`"claimed"` event) carries `(amount, yield_amount)`
— the actual, on-chain-verified total transfer and its yield-only portion.
The expected platform fee for a `claimed` event is:

```
expectedFee = floor(yieldAmountAtomic * feeBpsAtClaimTime / 10000)
```

computed with `BigInt` throughout (`domain/treasuryFeeMath.ts`'s
`computeExpectedPlatformFee`) — never floating point.

`feeBpsAtClaimTime` comes from replaying `"fee_upd"` events (published by
`update_platform_fee`) in ledger order alongside `"claimed"` events, carried
forward across ingestion runs via `TreasuryReconciliationCheckpoint.lastKnownFeeBps`
(defaulting to `1000`, matching `load_platform_fee_bps`'s own on-chain
default) — **not** from the backend's separate `PLATFORM_FEE_BPS` env var
(`settlement.ts`, see §1). This is the "versioned protocol configuration"
the acceptance criteria asks for: `configVersion` on every `TreasuryFeeRecord`
is `treasuryConfig.ts`'s `TREASURY_CONFIG_VERSION`, bumped only on a shape
change; the fee-bps value itself is versioned implicitly through its own
on-chain revision history.

## 4. Idempotent ingestion

Two independent layers, per the acceptance criterion's "idempotent by
network, transaction hash, and operation/event index":

1. **Checkpoint** (`TreasuryReconciliationCheckpoint`, one row per
   `(arenaId, network)`): bounds which ledger range is scanned per run,
   advisory-leased against concurrent runs. Structurally mirrors
   `ArenaProjectionCheckpointStore` (#1382,
   `docs/projection-checkpoint-replay.md`) — same conditional-`updateMany`
   lease-claim pattern, same "checkpoint only advances after a batch fully
   commits" durability rule — but is its **own**, separate job/table; it does
   not share state with, or depend on, the #1382 projection.
2. **Fee record uniqueness** (`TreasuryFeeRecord`, unique on
   `(network, sourceTxHash, sourceEventId)`): re-processing the same
   `"claimed"` event — duplicate RPC delivery, or a re-scanned batch after a
   crash before its checkpoint committed — upserts the same logical row
   rather than creating a duplicate. Re-running classification on every pass
   is intentional: it lets a `pending` record naturally resolve to
   `balanced`/`discrepant` once its ledger clears the finality window,
   without a separate "promote pending records" job.

## 5. Reconciliation status and discrepancy types

`domain/treasuryFeeMath.ts`'s `classifyReconciliation` (pure, exhaustively
unit-tested):

| Condition | status | discrepancyType |
|---|---|---|
| Source ledger has not cleared the finality grace window, or a ledger rollback is being recovered from (#1490, `ledgerContinuity.getRollbackGuard()`) | `pending` | `unfinalized_ledger` |
| Expected fee is `0` and no transfer found | `balanced` | — |
| Expected fee is `0` but a transfer was found anyway | `discrepant` | `unexpected_transfer` |
| Expected fee is nonzero and no transfer found | `discrepant` | `missing_transfer` |
| A transfer was found but its amount differs | `discrepant` | `amount_mismatch` |
| Amount matches but destination differs from the configured treasury address | `discrepant` | `destination_mismatch` |
| Amount and destination both match | `balanced` | — |

Given §1, every nonzero-fee record today reconciles as `missing_transfer`
once finalized — this is the expected, honest state of the system, not a
service defect.

## 6. Maintainer endpoint

`GET /api/admin/treasury/reconciliation` (`routes/treasury.ts`), admin-auth
only, **read-only** — no confirmation token (mirrors `admin.ts`'s
`/audit-logs` precedent: destructive admin ops need a token, reads don't).
Filters: `arenaId`, `status`, `discrepancyType`, `fromLedger`/`toLedger`,
`fromDate`/`toDate` (each pair validated `from <= to`), cursor-paginated
(`limit` 1–200, default 50; same base64url offset-cursor shape as
`roundRepository.ts`/`arenas.ts`). The response is an explicit field
allowlist (`serializeRecord`) rather than a raw Prisma row dump, so an
unrelated future column addition to the model doesn't silently start
round-tripping through this endpoint without a conscious decision — there is
no secret/credential on this model today, but the allowlist is the guard
against that ever changing unnoticed.

## 7. Metrics

`services/treasury/treasuryMetrics.ts`, registered on the shared registry:

- `inversearena_treasury_ingestion_runs_total{result}`,
  `inversearena_treasury_ingestion_duration_seconds`,
  `inversearena_treasury_lease_conflicts_total` — ingestion health (mirrors
  the #1382 projection metrics' shape).
- `inversearena_treasury_records_total{status}`,
  `inversearena_treasury_discrepancies_total{discrepancy_type}` — counters,
  incremented as records are written.
- `inversearena_treasury_unreconciled_count{status}`,
  `inversearena_treasury_unreconciled_age_seconds`,
  `inversearena_treasury_unreconciled_value_atomic{asset}` — gauges,
  recomputed on every `/metrics` scrape via `refreshTreasuryMetrics` (same
  pattern as `refreshArenaMetrics`), so they're always as fresh as the
  scrape rather than only as fresh as the last ingestion run.

Alerting thresholds and the investigation/replay procedure are in
`backend/docs/TREASURY_RECONCILIATION_RUNBOOK.md`.

## 8. Edge cases

- **Fee rounding**: `computeExpectedPlatformFee` floors — the same integer
  division Soroban's own `i128` arithmetic would produce. No separate "dust"
  field; unlike `settlement.ts`'s `computeSettlementBreakdown` (which tracks
  dust because it's computing an actual payout), this service is reporting
  an *expectation*, and a floored expectation is exact by definition.
- **Zero-fee configuration**: `feeBps == 0` always reconciles `balanced`
  (unless an unexpected transfer somehow exists) — covered explicitly in
  tests.
- **Contract upgrades**: this service reads only the two event topics it
  needs; an arena contract upgrade that changes unrelated entrypoints or
  events doesn't affect it as long as `"claimed"`/`"fee_upd"`'s payload shape
  is unchanged. A payload shape change would need a new decoder case (see
  `treasuryEventDecoder.ts`'s doc comment) — the decoder never throws on an
  unrecognized shape, so a future shape change degrades to `unknown` rather
  than crashing ingestion.
- **Transaction fee bumps**: irrelevant to this service — it reads
  `EventResponse.txHash`, which identifies the *inner* transaction regardless
  of fee-bump wrapping; Soroban RPC's event stream already resolves this.
- **Late events / reorgs**: `finalityGraceSeconds` (`treasuryConfig.ts`,
  default 120s) delays finalization; `getRollbackGuard().isQuarantined()`
  additionally holds records at `pending` for the duration of an active
  rollback recovery (#1490), regardless of how long ago the ledger closed.
- **Multi-asset decimals**: all amounts are atomic-unit `BigInt` throughout;
  `computeExpectedPlatformFee` is decimals-agnostic (a 6-decimal USDC amount
  and a 7-decimal XLM amount are both just integers to it) — covered by
  dedicated tests.

## 9. Compatibility

Purely additive: two new Prisma models
(`TreasuryFeeRecord`, `TreasuryReconciliationCheckpoint`), a new route, new
services. No existing table, endpoint, or contract entrypoint changes. No
contract changes at all — this is a backend-only reporting feature reading
existing on-chain events.
