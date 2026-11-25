# Release Preflight Design Note (#1465)

## Purpose
Provide a single, deterministic release preflight command (`make release-preflight` / `scripts/release-preflight.ts`) that validates database migrations, Soroban contract ABIs and deployment manifests, environment/network configuration, and rollback readiness before any production or testnet deployment proceeds.

## Ownership
- **Orchestrator (`scripts/release-preflight.ts`)**: Owns CLI parsing, bounded retries for transient checks, structured logging, machine-readable JSON reporting (`schemaVersion: 1`), and non-zero exit on any failed check.
- **Migrations (`backend/prisma`)**: Validates `migration_lock.toml`, migration SQL presence/non-emptiness, optional live `prisma migrate status` when `DATABASE_URL` is targeted, and destructive-DDL rollback guards.
- **ABIs (`contract/scripts/check-abi-compatibility.mjs`, `scripts/contract-manifest.ts`)**: Validates `contract/*/abi_snapshot.json`, `contract/deployment-manifest.json` (`schemaVersion`, contract IDs, WASM hashes, network passphrase), and compiled WASM ABI parity via `generate_abi_snapshots.sh --check` when WASM artifacts and `stellar`/`soroban` CLI are present.
- **Config (`backend/src/config/env.ts`, `scripts/env-example.ts`)**: Validates `.env.example` schema alignment and cross-checks network passphrases/RPC URLs against the target release network.
- **Rollback**: Verifies migration reversibility (flags unguarded `DROP TABLE` / `DROP COLUMN` / `TRUNCATE`), manifest rollback target validity, and compatibility-manifest prerequisites.

## State Transitions
Each check transitions through:
1. `pending` → `running` (attempt `1..maxRetries + 1`)
2. Transient I/O or subprocess failures retry with bounded backoff, incrementing `retries`
3. Terminal state: `pass` | `fail` | `skip` (e.g. live DB check skipped in offline `--dry-run` when `DATABASE_URL` is unset)

The aggregate preflight report transitions to:
- `pass`: All required checks are `pass` (or `skip` where explicitly optional in dry-run).
- `fail`: One or more checks are `fail` → CLI exits with code `1`.

## Failure Behavior & Edge Cases
- **Incompatible artifacts**: Missing/corrupt ABI snapshots, invalid contract IDs/WASM hashes, drifted `.env.example`, or empty/broken Prisma migrations immediately fail the check.
- **Network mismatch**: If `contract/deployment-manifest.json` or `STELLAR_NETWORK_PASSPHRASE` disagrees with `--network`, preflight fails with a `network_mismatch` error.
- **Partial failure**: All domains still run so operators see every failing artifact in one pass, while the overall status is `fail` (exit `1`).
- **Bounded input & concurrency**: File reads are size-bounded and independent domain checks avoid mutating shared state, making concurrent `--dry-run` invocations safe.

## Compatibility Constraints
- Preserves existing REST APIs, Prisma schema, and Soroban contract ABIs.
- Report format is explicitly versioned (`schemaVersion: 1`).
