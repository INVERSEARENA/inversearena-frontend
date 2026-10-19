# Design note: repository-wide protocol fixtures (#1464)

## Problem

The three codebases each re-derived their protocol domain objects inside
tests, with no shared source of truth. The backend alone had ~100 local
`makeX`/`buildX` helpers, and the same object (`RoundProofBundle`,
`ClaimInboxPage`, `ArenaConfig`, `ArenaState`) existed in several slightly
different copies. A field added to a real type but not to every inline fixture
produced tests that passed against a shape the product never emits. There was
also no deliberate way to build an *invalid* object: a malformed payload was
hand-rolled at the point of use, so "this input must be rejected" was asserted
against an accident rather than an intention.

## Ownership

| Scope | Module | Builds |
| --- | --- | --- |
| Frontend | `frontend/src/test-utils/protocolFixtures.ts` | `ArenaState`, `ArenaStateFromContract`, `ArenaStoreSnapshot`, `ClaimInboxComponent/Item/Page`, `RoundProofBundle` |
| Backend | `backend/tests/helpers/protocolFixtures.ts` | `RoundInput`, `RoundData`, `Payout`, `RoundResolution`, `RoundProofBundle`, `CommitReceipt`, `ClaimInboxComponent/Item/Page`, `ArenaProjectionState`, projection event sequence |
| Contracts | `contract/arena/src/fixtures.rs` | `ArenaConfig`, `PlayerState`, `YieldSnapshot`, `RoundResult`, `OracleFreshnessPolicy`, deterministic addresses |

Each module is test-only (`frontend` `test-utils/`, backend `tests/helpers/`,
Rust `#![cfg(test)]`), so nothing here can reach a production bundle. The
builders are the single owner of "what a valid X looks like" for tests; a new
required field on a domain type breaks the builder first, which is the point.

## State transitions

A fixture moves through three explicit states:

```text
valid default  ──override──►  valid custom  ──explicit invalid helper──►  rejected input
```

- **Valid default.** Every builder returns a fully-valid object with no
  arguments. Tests that do not care about a field never mention it.
- **Valid custom.** `Partial<T>` overrides (TS) or the varying-arg builders
  (Rust) reach the fields under test, so the delta dwarfs the boilerplate.
- **Invalid.** Every valid builder has an `invalid*` sibling on purpose:
  `invalidClaimInboxPage`, `invalidRoundInputPayload`, `invalidRoundInput`
  (domain invariant), `invalidArenaProjectionState`,
  `invalid::arena_config_inverted_deadlines`, and so on. The invalid helper is
  a named, reviewed statement of the exact violation a test relies on.

The one rule that keeps this honest: the invalid helpers are typed as the real
type where possible, not as `unknown`, so a test cannot use one where a valid
object is required without an explicit cast at the call site.

## Failure behaviour

The builders are pure: no clock, no randomness, no network. `buildX()` is
idempotent (same call → deeply-equal object) and returns a fresh object each
time, so mutating a fixture can never leak into the next call. A builder that
takes a `Date`/timestamp takes it from a fixed constant, never `now()` — a
fixture that changes with wall-clock time cannot be snapshot-tested.

Schema crosses are explicit. Where a Zod schema describes the *wire* form
(`RoundInputSchema`), the fixture module provides a separate
`buildRoundInputPayload()` for the flattened shape, so a test that crosses the
validation boundary does so deliberately instead of asserting that an in-memory
`Money` instance parses (it does not — the schema wants `{ atomicAmount,
assetCode }`).

## Observability

Fixture construction has no runtime path, so there is no success/failure/latency
to emit in production. Where a test wants to observe the build itself,
`buildWithTelemetry(kind, builder, sink)` emits one structured
`{"event":"fixture_build","kind","outcome","latencyMs"}` line — the same JSON
shape the repo's gates use — and rethrows on failure. The cross-module
integration test uses it; ordinary tests pass no sink and stay silent.

## Compatibility

No runtime, contract, schema, or API change. The builders mirror existing types
by import, not by copy, so they cannot drift from the product. Rust fixtures add
a `#[cfg(test)]` module only; the generated ABI snapshots are unaffected. The
backend and frontend fixture modules are intentionally separate (the two
packages do not share a types module), and the classes of object they own do not
overlap, so there is no second source of truth.

## Coverage

- Frontend: `frontend/src/test-utils/__tests__/protocolFixtures.test.ts`.
- Backend: `backend/tests/protocolFixtures.unit.test.ts` (registered in
  `test:ci`; ignored by Jest since it uses `node:test`).
- Contracts: `#[cfg(test)] mod tests` inside `contract/arena/src/fixtures.rs`.

Together these cover normal, boundary, retry/idempotency, and invalid-input
paths, plus one cross-module flow: build the projection event sequence, fold it
with the canonical projection, and derive a round phase from the result.
