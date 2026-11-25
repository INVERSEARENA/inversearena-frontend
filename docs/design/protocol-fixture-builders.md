# Repository-Wide Protocol Fixture Builders Design Note (#1464)

## Purpose
Provide a single, typed, invariant-enforcing set of fixture builders for InverseArena protocol domain objects (`Arena`, `Round`, `Commitment`, `Transaction`, `CompatibilityManifest`) across `frontend/src`, `backend/tests`, and `contract/test-support`.

## Ownership
- **TypeScript canonical builders (`frontend/src/shared/lib/testing/protocolFixtures.ts`)**: Owns typed domain fixture interfaces, deterministic valid defaults, runtime invariant validation (`FixtureValidationError`), explicit invalid-state helpers, and structured build metrics/logs.
- **Backend test adapter (`backend/tests/helpers/protocolFixtures.ts`)**: Re-exports canonical builders for Jest/`node:test` suites and adds backend-specific helpers (`TransactionRecord`, lifecycle transition checks against `lifecycle-transitions.json`).
- **Contract test support (`contract/test-support/fixtures.rs`)**: Owns Soroban `Env`-scoped fixture builders (`ArenaFixture`, `PayoutFixture`) and explicit invalid-state helpers for Rust contract tests.

## State Transitions & Invariants
- Every builder initializes with valid, deterministic defaults (valid Stellar `C...`/`G...` strkeys, `Test SDF Network ; September 2015` passphrase, positive stroop amounts, valid initial lifecycle states).
- `.build()` validates all invariants and throws `FixtureValidationError` if an invariant is violated.
- Invalid states (malformed IDs, `network_mismatch`, zero/negative amounts, invalid lifecycle transitions, duplicate idempotency keys, stale ledgers, max-size payloads) must be constructed explicitly via `.withInvalid*()` + `.buildInvalid()` or `.buildUnsafe()`.

## Failure Behavior & Observability
- `build()` fails fast with a typed `FixtureValidationError` listing the violated field and reason.
- `buildBatchWithRetry()` supports bounded retries for async/flaky seeders and records `success`, `failure`, `retry`, and `latencyMs` via `FixtureBuildMetrics` and structured logs.

## Compatibility Constraints
- Preserves all existing REST, Prisma, and Soroban contract schemas/ABIs.
- Fixture schema is versioned (`FIXTURE_SCHEMA_VERSION = 1`).
