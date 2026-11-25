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
| `tools/ops-cli/src/commands/restore.ts` | operator CLI `inverse-ops restore archived` |
| `contract/scripts/restore-archived.sh` | shell wrapper for the operator CLI restore command |

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

## Restoring archived entries

The keeper can only extend entries that are still live. Once `liveUntilLedgerSeq`
has passed, use the restore path instead:

```bash
contract/scripts/restore-archived.sh \
  C... get_option_count \
  --kind arena \
  --rpc-url https://soroban-testnet.stellar.org \
  --signer env:INVERSE_OPS_SIGNER \
  --submit
```

The first positional argument is the contract: a manifest kind (`factory`,
`oracle`, `vault`, `staking`, `payout`), `arena:<id>`, or a raw `C...` id with
`--kind`. The second is the method; any remaining positional values are method
arguments.

Omit `--submit` for a dry run. The command simulates the named contract method,
inspects `restorePreamble` and `archivedSorobanEntries`, and reports the exact
entries that need restoration. With `--submit` it builds a single
`RestoreFootprint` transaction from the simulation's transaction data and
submits it. Protocol 23+ usually auto-restores archived entries in the invoked
transaction; this manual path is for the fallback cases and for operators who
want to pay restoration fees up front.

The shell wrapper requires `pnpm` from the repository root and passes all
arguments to `inverse-ops restore archived`. It does not embed a secret; the
signer is resolved by the existing `env:` / `file:` / `ledger:` rules in
`tools/ops-cli/src/signer.ts`.

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
- **`expired` keys** — an entry already lapsed. Run
  `contract/scripts/restore-archived.sh` (or `inverse-ops restore archived`) and
  re-check `ttl:plan`; TTL renewal cannot recover an archived entry.
- **`failed` renewals** — check RPC health and that the keeper's admin key
  still holds authority on the contract (a lost admin key surfaces here as
  every renewal failing).
- **`unreadable` (`headroom = -1`)** — `getLedgerEntries` failed for that key;
  usually a transient RPC issue, but persistent `-1` on a key that should exist
  means the entry may already be gone.

## Operating cost of TTL bumps

A TTL bump is a Soroban ledger-entry write, so it consumes write bytes and an
entry slot in the transaction footprint. The contracts call `extend_ttl` only
when an entry is below the 518,400-ledger threshold; the host does not charge a
write when the entry is already above it. A typical arena lifecycle therefore
has two cost regimes:

| Phase | Cost |
| --- | --- |
| Active arena (entries refreshed by normal calls) | No incremental ledger writes; only the host call overhead of checking TTL |
| Arena idle for more than ~30 days | The first read or write of each fund-bearing key pays one restore-to-one-year write; subsequent calls in that window are back to no incremental writes |
| Archived entry (past its live TTL) | Cannot be bumped; requires a separate `RestoreFootprint` transaction via the restore tooling |

At the maximum arena size (100 players), the fund-bearing footprint is bounded
by the current roster, resolution pages, leaderboard accumulator and the arena
configuration/instance entries; per-player temporary commitment and choice keys
are not kept alive after the round. `contract/scripts/cost-bench.mjs` compares
the compiled-WASM measurements for `join_arena`, `submit_commitment`,
`reveal_choice`, `resolve_round`, `claim` and `claim_refund` at 10/50/100 players
against [`contract/cost-baseline.json`](../contract/cost-baseline.json). Review
that summary when changing TTL logic: a new key in a fund-moving footprint must
be justified by a baseline diff, and every benchmark must remain within the
network limits documented in
[`contract/docs/COST_BENCHMARKS.md`](../contract/docs/COST_BENCHMARKS.md).

## Scheduling

The keeper must run as a **single leader** (or accept that concurrent workers
are harmless because renewal is idempotent). Recommended cadence is daily for
mainnet with a threshold comfortably larger than a day's ledgers.
