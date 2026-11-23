# Contract storage TTL keeper (#1516)

Soroban persistent storage expires unless extended. This runbook explains how
Inverse Arena observes TTL headroom across deployed contracts and how to run
the bounded keeper that renews it.

## Why TTL is observed off-chain

A Soroban contract **cannot read its own entry TTL at runtime** — the SDK
exposes TTL reads only to the test host (`testutils::storage::Persistent::get_ttl`).
Therefore:

- the **contract** owns the key *inventory* (`storage_inventory`, additive,
  read-only) and the *renewal* entrypoint (`renew_storage`, admin-gated,
  idempotent), and
- the **keeper** observes the actual remaining headroom via RPC
  `getLedgerEntries`, which returns each entry's `liveUntilLedgerSeq`.

`contract/staking` ships this interface at `CONTRACT_VERSION = 2`; the backend
negotiates `storage_inventory`/`renew_storage` via `contractCapability.ts`
before using them, so older instances are skipped rather than probed.

## Components

| Path | Role |
| ---- | ---- |
| `contract/staking/src/lib.rs` | `storage_inventory` + `renew_storage` (bounded, idempotent) |
| `backend/src/services/onChainTtlReader.ts` | RPC `getLedgerEntries` adapter (only RPC in the keeper) |
| `backend/src/services/ttlKeeperPlan.ts` | pure planner: identity + threshold + bounds |
| `backend/src/services/ttlKeeperService.ts` | orchestration: statuses, metrics, execution |
| `backend/src/scripts/ttlKeeperPlan.ts` | dry-run CLI (`npm run ttl:plan`) |

## Renewal rules

- **Identity fail-closed.** A contract is renewed only when its observed
  network passphrase and `version()` positively match the deployment manifest.
  Unknown network/version ⇒ skip (`identity_uncertain`); mismatch ⇒
  `network_mismatch` / `version_mismatch`.
- **Threshold is strict.** A key is renewable when its headroom is **strictly
  below** `TTL_KEEPER_RENEW_BELOW_LEDGERS`. Headroom equal to the threshold is
  healthy.
- **Expired is not renewable.** A key with non-positive headroom has already
  expired and must be *restored*, not TTL-extended; the planner reports it as
  `expired` so it surfaces for manual remediation instead of looping forever.
- **Bounded.** Candidates are ordered by urgency and capped by
  `TTL_KEEPER_MAX_RENEWALS_PER_RUN` and `TTL_KEEPER_MAX_RENEWALS_PER_CONTRACT`.
  Overflow is reported as `rate_limited` and picked up on the next run.
- **Idempotent.** `renew_storage` extends only entries inside the threshold, so
  a restart or duplicate worker re-running an already-renewed contract is an
  on-chain no-op.

## Configuration

| Env var | Meaning | Default |
| ------- | ------- | ------- |
| `TTL_KEEPER_MANIFESTS` | JSON array of `{contractId, kind, network, version}` | `[]` (disabled) |
| `TTL_KEEPER_RENEW_BELOW_LEDGERS` | Renewal threshold | `1000` |
| `TTL_KEEPER_MAX_RENEWALS_PER_RUN` | Per-run key-target cap | `25` |
| `TTL_KEEPER_MAX_RENEWALS_PER_CONTRACT` | Per-contract key-target cap | `10` |

Targets are derived **only** from validated manifests — the keeper never renews
a contract it merely discovered on the network. A malformed manifest (bad
contract id, non-positive version, duplicate id) aborts the run rather than
silently dropping a target.

## Dry-run

```bash
TTL_KEEPER_MANIFESTS='[{"contractId":"C...","kind":"staking","network":"Test SDF Network ; September 2015","version":2}]' \
  npm run ttl:plan
```

Prints the machine-readable plan (`currentLedger`, `renew[]`, `skip[]`, empty
`results[]`) and **never submits**. Review before enabling the scheduler.

## Metrics & alerts

| Metric | Meaning | Suggested alert |
| ------ | ------- | --------------- |
| `inversearena_ttl_keeper_headroom_ledgers{contract,key}` | Headroom per key (`-1` = unreadable) | `min_over_time(...) < 250` for 10m — page |
| `inversearena_ttl_keeper_renewals_total{contract,status,reason}` | Renewal outcomes (`submitted`/`confirmed`/`failed`) | any `status="failed"` increase over 15m |
| `inversearena_ttl_keeper_confirmation_lag_seconds{contract}` | Submit→confirm latency | p95 `> 120`s |
| `inversearena_ttl_keeper_identify_failures_total{contract,reason}` | Renewals skipped on identity uncertainty | any increase — investigate manifests/RPC |

Minimum-headroom alerts are the early warning; renewal-failure and
confirmation-lag alerts are the "the fix isn't working" signal.

## Operator responses

- **`identity_uncertain` / `*_mismatch` spikes** — the manifest version or
  network no longer matches the deployment (e.g. after a contract upgrade).
  Update `TTL_KEEPER_MANIFESTS` for that instance.
- **`expired` keys** — an entry already lapsed. Restore it via a Soroban
  `RestoreFootprint` / re-initialisation path; TTL renewal cannot recover it.
- **`failed` renewals** — check RPC health and that the keeper's admin key
  still holds authority on the contract (a lost admin key surfaces here as
  every renewal failing).
- **`unreadable` (`headroom = -1`)** — `getLedgerEntries` failed for that key;
  usually a transient RPC issue, but persistent `-1` on a key that should exist
  means the entry may already be gone.

## Scheduling

The keeper must run as a **single leader** (or accept that concurrent workers
are harmless because renewal is idempotent). Recommended cadence is daily for
mainnet with a threshold comfortably larger than a day's ledgers.
