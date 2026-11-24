# Public Datasets

InverseArena publishes nightly exports of settled arena outcomes for independent analysis and fairness auditing.

## Endpoints

### `GET /api/datasets`

Returns a list of available export dates.

```json
{
  "datasets": [
    { "date": "2024-11-25", "manifestUrl": "/api/datasets/2024-11-25" }
  ]
}
```

### `GET /api/datasets/:date`

Returns the manifest for a specific export date.

```json
{
  "schemaVersion": 1,
  "settlementDate": "2024-11-25",
  "generatedAt": "2024-11-26T00:05:00Z",
  "files": {
    "arenas": {
      "filename": "settled_arenas_2024-11-25.csv",
      "rowCount": 148,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb924...",
      "byteSize": 24680
    }
  }
}
```

### `GET /api/datasets/:date/:filename`

Downloads the raw CSV file. Set `Content-Type: text/csv`.

## CSV Schema

| Column | Description |
|---|---|
| `contract_id` | Soroban arena contract ID |
| `ledger` | Ledger sequence of settlement |
| `tx_hash` | Transaction hash on Stellar |
| `settled_at` | ISO-8601 timestamp |
| `winner_wallet` | Winner's public key (no aliases or emails) |
| `payout_amount` | Raw amount in asset's smallest unit |
| `asset` | Asset code (e.g. `XLM`, `USDC`) |

## Verification

Verify any file using its `sha256` from the manifest:

```bash
sha256sum settled_arenas_2024-11-25.csv
# compare the hex output to manifest.files.arenas.sha256
```

Each row references on-chain data via `contract_id`, `ledger`, and `tx_hash` so any party can replay and verify outcomes independently.

## Privacy

No PII is included. Only wallet addresses (public keys) appear; no aliases, emails, or profile data.
