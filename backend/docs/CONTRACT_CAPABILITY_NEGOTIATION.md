# Contract Capability Negotiation Across Mixed Deployment Versions (#1409)

See [METRICS.md](./METRICS.md#contract-capability-negotiation-metrics-1409) for
the exposed metrics. This note covers ownership/design.

## Ownership

- **contract/{arena,factory,payout,staking}/src/lib.rs** each own their own
  `version()` entrypoint and `CONTRACT_VERSION` constant, independent counters
  per contract kind (arena is at 2; factory/payout/staking start at 1, having
  had no version tracking before this issue).
- **onChainReader.getOnChainContractVersion** owns reading a specific deployed
  instance's `version()` over Soroban RPC, via the same `simulateViewCall`
  plumbing every other on-chain read in this file uses.
- **contractCapability.ts** owns everything else: the entrypoint-to-minimum-version
  map, negotiation caching, retry-with-backoff, and the
  `isEntrypointSupported`/`assertEntrypointSupported` checks call sites use.

## State transitions

Negotiation result is a fact about one deployed contract *instance*
(`${contractKind}:${contractId}`), not about a contract kind in general - two
arena instances can be negotiated independently and land on different
versions, which is the actual "mixed deployment versions" scenario this issue
is about (an old arena still finishing its round, a new arena created after
an upgrade).

```
no cache entry, or cache entry older than 5 min -> read version() on-chain (with retry)
  read succeeds -> cache the version, cache hit for 5 min
  read fails (after retries exhausted) -> throw CapabilityNegotiationError, cache NOT written
cache entry, fresher than 5 min -> return cached version, no RPC call
```

A failed negotiation is deliberately not cached: a transient RPC blip
shouldn't make every caller treat that contract instance as unreachable for
the rest of the 5-minute window.

## Failure behavior

- Up to 3 attempts with exponential backoff (100ms, 200ms) before surfacing
  `CapabilityNegotiationError` to the caller.
- Retries are skipped once the shared Soroban circuit breaker
  (`getSorobanBreaker`, also used by `ledgerClock`) is open - retrying into an
  open circuit would just keep failing until the breaker's own reset timeout,
  so negotiation stops early instead of burning its retry budget on a call
  that cannot succeed yet.
- A version read failure is never silently defaulted to "assume some
  version" - unlike `getOnChainGameState`/`getOnChainPlayerCount` elsewhere in
  `onChainReader.ts`, which intentionally default on failure because a
  missing game state has a safe fallback. There is no safe default version to
  assume: guessing wrong in either direction either hides a genuinely
  unsupported call or blocks a genuinely supported one.

## Compatibility constraints

- Entrypoints with no entry in `contractCapability.ts`'s capability map are
  always treated as supported - the map only needs entries for entrypoints
  added *after* a contract kind's initial release, once a concrete
  version boundary for that entrypoint is known. It ships empty in this
  change; the mechanism is exercised by `contractCapability.unit.test.ts` and
  `contractCapability.integration.unit.test.ts` via their test-only capability
  map override, since inventing a version-boundary claim for an existing
  entrypoint without direct evidence would be guessing.
- `isEntrypointSupported` returns a boolean for call sites that want to
  branch (e.g. show/hide a UI action); `assertEntrypointSupported` throws
  `UnsupportedEntrypointError` for call sites that should abort outright.
  Both hide the unsupported entrypoint before attempting the call - Soroban
  has no reliable "method not found" signal distinct from other simulation
  failures, so negotiating up front is the only way to fail predictably.
- Existing public behavior is unchanged: every current caller of
  `onChainReader.ts`'s existing exports is untouched;
  `getOnChainContractVersion` and `contractCapability.ts` are new, additive
  surface only.

## Known limitation

`contractCapability.ts` lazily (`await import(...)`) imports
`onChainReader.getOnChainContractVersion` instead of importing it at module
load time. This is not a style choice - `onChainReader.ts` transitively
imports `frontend/src/shared-d/services/stellarRpcGateway.ts`, which uses the
frontend package's own `@/` path alias; the backend's `tsconfig`/jest/tsx
configuration has no mapping for that alias, so any static top-level import
of `onChainReader.ts` fails to resolve at both typecheck and runtime. This is
a pre-existing, repo-wide gap (confirmed identical against a clean clone of
upstream `main`, predating this change, and already visible in
`tests/onChainReader.snapshot.unit.test.ts`'s use of a `setRpcServerForTest`
seam that didn't previously exist on this branch, now added alongside this
feature). Fixing the underlying cross-package module resolution is out of
scope here; the lazy import keeps `contractCapability.ts` itself fully
testable in the meantime, and production code (which does execute the
dynamic import) is unaffected.
