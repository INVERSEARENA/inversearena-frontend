# Vault Shortfall Runbook

Covers detection and response when a vault's balance falls below its total
liabilities (issue #1637).

## Signals

| Signal | Source | Meaning |
|---|---|---|
| `short` event | `rwa-adapter` contract | Withdrawal could not be paid in full |
| `vault_balance_decreased` event | `arena` contract | Vault balance dropped below a floor |
| `vault_coverage_ratio < 1.05` | `VaultShortfallWorker` | Warning: buffer eroding |
| `vault_coverage_ratio < 1.00` | `VaultShortfallWorker` | Critical: vault insolvent |

## Metrics

- **`vault_coverage_ratio{arena_id}`** — current balance ÷ liabilities. Scrape at `/metrics`.
- **`vault_shortfall_events_total{arena_id, event_type}`** — cumulative events.
- **`vault_shortfall_alerts_total{arena_id, severity}`** — alerts dispatched.

## Alert thresholds

Configurable via env vars:

| Variable | Default | Meaning |
|---|---|---|
| `VAULT_WARN_COVERAGE_RATIO` | `1.05` | Ratio below which a warning is raised |
| `VAULT_CRIT_COVERAGE_RATIO` | `1.00` | Ratio below which a critical alert fires |
| `VAULT_ALERT_DEDUP_MS` | `300000` | Suppress duplicate alerts within this window |
| `VAULT_CHECK_INTERVAL_MS` | `60000` | How often the periodic check runs |

## Response: warning (coverage < 1.05)

1. Check `vault_coverage_ratio` in Grafana for trend (falling or stable).
2. Identify the arena ID from the alert label.
3. Query pending withdrawals and payouts against that arena in the DB.
4. If the ratio is stable and above 1.0, monitor — no immediate action needed.
5. If the ratio is trending toward 1.0, prepare to pause the arena before it
   becomes insolvent (see Critical response below).

## Response: critical (coverage < 1.00)

1. **Immediately pause the arena** to stop new joins and payouts:
   ```bash
   stellar contract invoke --id $ARENA_CONTRACT_ID --network mainnet \
     -- pause --admin $ADMIN_ADDRESS
   ```
2. Notify users via the frontend banner (set `NEXT_PUBLIC_MAINTENANCE_MODE=1`).
3. Identify the shortfall source:
   - Was a large payout processed that emptied the vault?
   - Was a `short` event replayed during re-indexing (suppress and re-check)?
   - Was there an off-chain accounting error?
4. Top up the vault balance if the shortfall is due to a processing error.
5. Once coverage > 1.05, unpause:
   ```bash
   stellar contract invoke --id $ARENA_CONTRACT_ID --network mainnet \
     -- unpause --admin $ADMIN_ADDRESS
   ```
6. File an incident report referencing the Sentry event ID.

## Alert storm suppression during re-indexing

Set `VAULT_ALERT_DEDUP_MS=0` to disable deduplication only if you need
every event logged. During a re-index from block 0, set it to a large value
(e.g. `3600000` = 1 hour) to suppress replay noise.
