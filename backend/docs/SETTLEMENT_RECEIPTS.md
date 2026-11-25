# Post-Game Settlement Manifest & Receipt (#1407)

## Ownership

- **settlementService** (`src/services/settlementService.ts`) owns the pure
  breakdown math (`computeSettlementBreakdown`) and manifest/CSV rendering
  (`buildSettlementManifest`, `toReceiptCsv`).
- **roundService.computePayouts** owns *producing* the breakdown for a
  round-settlement payout, alongside the payout amount it already computed.
- **PaymentService** owns *persisting* a breakdown a caller supplies at
  payout-creation time (`CreatePayoutRequest.breakdown`, optional) — it does
  not compute or validate game economics itself.
- **PayoutsController** owns exposing the receipt, gated by the same
  `canAccessTransaction` ownership rule as `GET /api/payouts/:id`.

## Reconciliation identity

```
principal + yieldAmount === netPayout + platformFee + dust
```

- `principal` = winner's own stake + every eliminated player's forfeited stake.
- `yieldAmount` = oracle yield earned on the eliminated stake pool.
- `platformFee` = a bps cut of `yieldAmount` only, **never** `principal`.
- `dust` = the fractional remainder the integer stroop-precision fee math
  discards (recorded, not silently dropped).

## Failure behavior / compatibility

`PLATFORM_FEE_BPS` defaults to `0`. At the default, `netPayout` is
byte-for-byte the same value `roundService` computed before this feature
existed — this is a reporting/reconciliation feature, not a change to what
anyone gets paid, unless an operator explicitly opts into a nonzero fee (see
`contract/arena/src/lib.rs`'s `update_platform_fee` doc comment: the fee is
stored on-chain but not yet deducted from any payout there either).

A payout created without a breakdown (e.g. an ad-hoc admin payout via
`POST /api/payouts`) has no `principal`/`yieldAmount`/`platformFee`/`dust` —
its receipt reports the lump amount as `principal`/`netPayout` with the rest
`0` rather than fabricating a split that was never computed.

`GET /api/payouts/:id/receipt[.csv]` returns `409 PAYOUT_NOT_SETTLED` until
`status === "confirmed"` — before that there is no `txHash` to reconcile
against.

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/payouts/:id/receipt` | wallet owner (JWT) | JSON `SettlementManifest` |
| `GET` | `/api/payouts/:id/receipt.csv` | wallet owner (JWT) | `Content-Disposition: attachment`; `payoutId` is sanitized before use in the header to rule out header/CRLF injection |

## Frontend

`DownloadReceiptButton` (`frontend/src/components/archives/table/DownloadReceiptButton.tsx`),
wired into the archives `HistoryTable`. The archives page is currently
mock-data-only; wiring it to real match/payout data is a separate, larger
effort tracked outside this ticket.
