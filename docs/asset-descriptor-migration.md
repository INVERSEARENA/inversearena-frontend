# Canonical asset descriptor & amount codec (#1521)

This document defines the canonical, versioned asset identity used across the
backend and describes how to migrate the remaining legacy asset shapes.

## The descriptor

`backend/src/types/assetDescriptor.ts` defines `AssetDescriptor`:

| field           | type                          | notes                                                                 |
| --------------- | ----------------------------- | --------------------------------------------------------------------- |
| `schemaVersion` | `1`                           | additive API schema version; bump on breaking change                   |
| `kind`          | `"native" \| "issued"`        | native is XLM only                                                     |
| `code`          | `string`                      | `XLM` for native; uppercase alphanumeric 1–12 for issued              |
| `issuer`        | `string \| null`              | issuer account; required for classic issued, `null` for native         |
| `contractId`    | `string \| null`              | Stellar Asset Contract id (SAC-first assets set this, may omit issuer) |
| `decimals`      | `number` (0–18)               | minor units per whole unit = `10 ** decimals`                          |
| `network`       | `string`                      | canonical network passphrase                                            |

An **issued** asset must be anchored by an `issuer`, a `contractId`, or both.
Equality is by `assetIdentityKey()` — network + kind + code + issuer +
contractId + decimals — **never** by display symbol.

## Exact amount codec

All amounts are integer minor units (`bigint`). Floating-point is rejected:

- `toMinorUnits(amount: string | bigint, decimals, policy)` — the only accepted
  inputs are an exact decimal string or a `bigint`. Passing a JS `number`
  throws, because a float cannot represent minor units exactly.
- `fromMinorUnits(atomic: bigint, decimals, { trimTrailingZeros? })` — exact,
  never rounds; trimming is display-only.

Rounding is explicit via `RoundingPolicy`:

| policy     | behaviour                                                        |
| ---------- | ---------------------------------------------------------------- |
| `reject`   | throw `RoundingRequiredError` if the value is not exactly scalable |
| `floor`    | round toward −∞                                                  |
| `ceil`     | round toward +∞                                                  |
| `halfUp`   | round ties away from zero                                        |
| `halfEven` | banker's rounding                                                |

Overflow past the signed 128-bit range throws `AmountOverflowError` — the
width the arena contracts store amounts in.

## Compatibility adapter

`adaptLegacyAsset()` (and its production bridge `migrateLegacyAsset()` in
`backend/src/services/assetMigration.ts`) accepts a legacy shape and returns a
validated descriptor. It **rejects** ambiguous input instead of guessing:

- a display `symbol` alone is not an identity;
- an issued asset with neither issuer nor contract id;
- an issued asset without explicit decimals;
- a missing network.

Every successful adaptation emits `inversearena_legacy_asset_migration_total{legacy_form}`.

## Remaining legacy fields (migration plan)

These still carry asset identity without a descriptor and should be migrated in
follow-ups; each maps to a `legacy_form` value above:

| location                                   | legacy field(s)            | migration step                                             |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------------- |
| `backend/src/services/paymentService.ts`   | `asset: z.enum(["XLM","USDC"])`, `toStroops()` (hardcoded 7 dp) | accept an optional `assetIdentity` descriptor; scale with `toMinorUnits(exact)`; verify before building the tx |
| `backend/src/types/asset.ts`               | `ASSET_DECIMALS` lookup by `code` | derive decimals from the descriptor; deprecate the code table |
| `backend/src/routes/pools.ts`              | `AssetMetadata` (no contractId/network) | serialise the descriptor shape in the create-pool request/response |
| frontend stake/create forms                | asset `code`/`symbol`      | submit and render the descriptor shape                     |

**Out of scope:** migrating every historical monetary column; adding exchange
rates.
