# Oracle Freshness Policy — Design Note

Issue: #1512 "Enforce oracle freshness policy before yield-dependent arena actions"

This note defines the design for a versioned oracle freshness policy spanning
the contract and backend layers, so a stale or missing oracle observation is
detected and rejected explicitly instead of silently trusted.

## 1. Background

- **Contract**: `contract/oracle/src/lib.rs`'s `OracleContract` stored only a
  bare `rate_bps` — no timestamp of when it was set. `contract/arena/src/lib.rs`'s
  `resolve_round` (the only on-chain read of the oracle) called
  `oracle::fetch_yield_bps`, which falls back to `0` on any failure
  ("liveness over precision" — a deliberate, already-tested tradeoff this
  change does not touch for genuine unavailability).
- **Backend**: `RoundController.resolveRound` accepts a **client-supplied**
  `oracleYield` number in the request body
  (`RoundInputSchema`, validated only as `0 <= n <= 100`) and feeds it
  directly into `buildRoundResolution`/`computeSettlementBreakdown`'s payout
  math — with no independent re-fetch or freshness check of its own. This was
  the largest gap: round resolution's actual settlement math never confirmed
  the oracle data behind the number it was given was even recent.
- **Off-chain feed**: `GET/POST /api/oracle/yield` (Ondo-sourced, pushed via a
  signed webhook) is cached in Redis with a `lastUpdated` field that nothing
  read for staleness before this change.
- **Frontend**: `TotalYieldPot` unconditionally rendered "ORACLE VERIFIED"
  regardless of whether the underlying rate was ever confirmed recent.

## 2. Versioned policy

- **Contract** (`contract/arena/src/types.rs`): `OracleFreshnessPolicy { max_age_secs, warn_age_secs, version }`,
  `FRESHNESS_POLICY_VERSION = 1`. Per-arena-instance, admin-configurable via
  `set_oracle_freshness_policy` (mirrors the existing `update_platform_fee`
  pattern — no `initialize` signature change), defaulting to
  `DEFAULT_ORACLE_MAX_AGE_SECS` (3,600s) / `DEFAULT_ORACLE_WARN_AGE_SECS`
  (1,800s) until reconfigured. `validate_freshness_policy` rejects
  `warn_age_secs > max_age_secs`, either being `0`, or `max_age_secs` above
  the hard ceiling `MAX_ORACLE_MAX_AGE_SECS` (86,400s) — this is the
  contract-side "startup validation."
- **Backend** (`backend/src/config/oracleFreshnessConfig.ts`): the same
  thresholds as environment-configured defaults
  (`ORACLE_MAX_AGE_SECONDS`/`ORACLE_WARN_AGE_SECONDS`), validated at process
  startup via `validateConfig()` (`backend/src/config/validate.ts`) — a
  misconfigured policy fails the process at boot, not on first yield-dependent
  request. This is a default/fallback for reads that don't (or can't) consult
  a specific arena's own on-chain policy, since each arena instance can
  independently reconfigure its own.

## 3. Oracle reads expose provenance

- `contract/oracle/src/lib.rs`: new `get_oracle_reading()` view returns
  `OracleReading { rate_bps, observed_at, source_version }`, additive
  alongside the unchanged `get_current_yield_bps`. `set_yield_bps`/`initialize`
  now record `observed_at` (ledger timestamp); a new `rate_obs` event carries
  `(rate_bps, observed_at)` (the existing `rate_set` event's payload is
  unchanged, for compatibility).
- `contract/arena/src/lib.rs`: new `get_oracle_contract()` view exposes which
  oracle instance an arena reads from — previously only stored inside
  `ArenaConfig` with no getter, so an off-chain reader had no way to discover
  it.
- `backend/src/services/onChainReader.ts`: `getOracleReading` /
  `getArenaOracleContract` mirror the contract-side reads.
- `backend/src/services/oracleFreshnessService.ts`'s `classifyFreshness`
  mirrors `contract/arena/src/oracle.rs`'s `classify_freshness` exactly (same
  threshold semantics, same treatment of a missing/future-dated observation)
  so the backend's independent check and the on-chain `resolve_round` check
  agree on what counts as stale.

## 4. Freshness classification

Four states (`Fresh` / `Warning` / `Stale` / `Unavailable`), both in Rust
(`contract/arena/src/oracle.rs::OracleFreshness`) and TypeScript
(`oracleFreshnessService.ts`'s `OracleFreshness`):

- **Fresh**: age < `warn_age_secs`.
- **Warning**: `warn_age_secs` <= age < `max_age_secs` — still usable, but
  surfaced via event/metric for alerting before it actually blocks anything.
- **Stale**: age >= `max_age_secs`, **or** no observation was ever recorded
  (`observed_at == 0`), **or** the observation is future-dated relative to
  `now` (clock/ledger divergence — treated as untrustworthy, not silently
  fresh).
- **Unavailable**: the oracle could not be reached at all, or predates
  `get_oracle_reading` (mixed deployment version). Deliberately **not**
  treated as `Stale` — see §5.

## 5. Where staleness is enforced (and where it deliberately isn't)

| Mutation | Enforcement | Rationale |
|---|---|---|
| `resolve_round` (contract) | Rejects `Stale` with `ArenaError::StaleOracleData`, before any state write. `Unavailable` does **not** reject — the existing liveness-first `fetch_yield_bps` fallback is unchanged. | The only on-chain yield-dependent mutation. Rejecting `Unavailable` too would let an RPC hiccup between the arena and oracle contracts brick round resolution entirely — a much worse outcome than the pre-existing 0-bps fallback. |
| `RoundService.resolveRound` (backend) | Calls `OracleFreshnessService.assertFresh`, which throws a typed, recoverable `StaleOracleDataError` (mapped to `409 STALE_ORACLE_DATA` by `RoundController`) for `Stale`, not for `Unavailable`. | Closes the actual gap: the backend's own settlement math trusts a client-supplied `oracleYield` with no freshness check of its own today. This does not (and is not intended to) validate that the *value* is correct — only that *some* recent observation exists. Validating the value itself against the oracle is a separate, harder problem (rounding, timing skew) and is out of scope. |
| Arena creation / `start_round` | **Not enforced** — neither currently reads the oracle at all in this codebase. Adding a freshness gate to actions that have no oracle dependency would be inventing behavior, not enforcing an existing one. `OracleFreshnessService`/`get_oracle_reading` are general-purpose and ready for this the moment either flow gains a real yield dependency. |
| `GET /api/oracle/yield`, `GET /api/oracle/keeper-status` | Read-only classification, never blocks anything — see §6/§7. | These are reads, not mutations. |

## 6. Read-only UI

`GET /api/oracle/yield` now additionally returns `freshness` and `ageSeconds`
(computed from the cached `lastUpdated` timestamp against the same
`classifyFreshness`, so the webhook-fed off-chain feed and the on-chain
oracle share one staleness definition). `TotalYieldPot`
(`frontend/src/components/arena/core/TotalYieldPot.tsx`) no longer
unconditionally claims "ORACLE VERIFIED" — a `stale`/`unavailable`
classification now renders a red "RATE STALE" badge and the reading's age
instead. `warning` renders "VERIFYING…". This is intentionally a targeted fix
to the one component making an explicit verification claim; the sibling
`ChoiceCard` "estimated yield" figures already frame themselves as estimates
and were left alone.

## 7. Keeper-facing status, without external fetching

`GET /api/oracle/keeper-status` (admin-authenticated) reads only the
already-cached feed value via `cache.get` and classifies it —
it never calls out to Ondo/Band/etc. itself, satisfying "identifies overdue
updates without performing external data fetching." `overdue` is true for
`stale` or `warning`.

## 8. Metrics

- `inversearena_oracle_freshness_classification_total{classification}` —
  every classification performed.
- `inversearena_oracle_staleness_seconds{oracle_contract}` — gauge, last
  observed age.
- `inversearena_yield_dependent_actions_blocked_total{action,reason}` —
  incremented (`reason="stale_oracle_data"`) whenever `assertFresh` rejects.

## 9. Edge cases (acceptance criteria)

- **Exact thresholds**: `age == warn_age_secs` is `Warning` (not `Fresh`);
  `age == max_age_secs` is `Stale` (not `Warning`). Covered by contract tests
  `resolve_round_accepts_oracle_reading_at_exact_warn_threshold` /
  `resolve_round_rejects_oracle_reading_at_exact_max_age` and the backend's
  `classifyFreshness` unit tests.
- **Clock/ledger divergence, future timestamps**: an `observed_at` after
  `now` classifies as `Stale`, both in Rust and TypeScript — see
  `resolve_round_rejects_future_dated_oracle_observation`.
- **Rollback**: not directly simulable at the single-contract-invocation
  level the Rust test harness offers; the backend already has a general
  ledger-rollback-recovery mechanism (`ledgerContinuity.ts`,
  `docs/LEDGER_ROLLBACK_RUNBOOK.md`, #1490) that quarantines on-chain reads
  during recovery — an oracle read performed while quarantined is exactly an
  `Unavailable`/stale-by-staleness classification from this feature's
  perspective, so no additional mechanism is introduced here.
- **Missing metadata / no observation yet**: `observed_at == 0` classifies as
  `Stale`, not `Unavailable` — the oracle answered, it just has nothing to
  report. Covered by `resolve_round_rejects_when_oracle_has_no_observation_ever`.
- **Paused oracle**: the oracle contract itself has no pause flag; an
  admin who stops calling `set_yield_bps` naturally surfaces as increasing
  staleness, which this feature already detects — no separate mechanism
  needed.
- **Rate zero**: `rate_bps == 0` is a valid, fresh-or-stale-independent
  value; freshness classification never inspects the rate itself, only
  `observed_at`.
- **Mixed deployment version / oracle upgrade**: a pre-#1512 oracle with no
  `get_oracle_reading` classifies as `Unavailable` (contract:
  `resolve_round_proceeds_when_oracle_predates_freshness_metadata`); a
  reading with a different `source_version` does not by itself affect
  classification (`resolve_round_proceeds_with_mismatched_oracle_source_version`).
- **Cached reads**: `GET /api/oracle/yield` is deliberately **not** wrapped in
  `cacheMiddleware` — see the inline comment in `routes/oracle.ts` — because
  it would freeze the `ageSeconds`/`freshness` fields into the cached
  response for the TTL window, defeating the point of reporting them
  accurately.

## 10. Compatibility

- `get_current_yield_bps` and the `rate_set` event are unchanged.
- `resolve_round`'s signature is unchanged; its new staleness check is a
  behavior change, gated by `CONTRACT_VERSION` bumping to `3` so
  `contractCapability.ts`'s negotiation can distinguish arena instances that
  have the new `set_oracle_freshness_policy`/`get_oracle_freshness_policy`/
  `get_oracle_contract` entrypoints from older ones that don't.
- `GET /api/oracle/yield`'s response gains additive `freshness`/`ageSeconds`
  fields; existing consumers reading only the original shape are unaffected.

## 11. Prerequisite fixes bundled into this change

Discovered while implementing and verifying this feature, both blocking
(directly or adjacently) the files this issue needed to touch:

- `backend/src/services/{arenaService,roundService,onChainReader}.ts` all
  imported `StellarRpcGateway` via a relative path one directory level too
  shallow (`../../frontend/...` instead of `../../../frontend/...`), which
  resolves to a nonexistent `backend/frontend/` and fails at actual runtime,
  not just under strict `tsc`. This broke arena creation's on-chain
  confirmation, round resolution's on-chain submission, and
  `getOnChainTotalYield` on `main` prior to this change.
- `backend/src/services/roundService.ts`'s `resolveRound` referenced an
  undefined `eliminatedPlayers` (should have been `result.eliminatedPlayers`)
  immediately after committing a round's resolution to Postgres — every
  round resolution was throwing a `ReferenceError` right after its DB write
  landed.
- `backend/src/routes/index.ts` called `createDashboardRouter(requireAuth)`
  without ever importing `createDashboardRouter` — a `ReferenceError` that
  crashes `createApiRouter()`, i.e. the entire backend server, at boot.

None of these are otherwise related to oracle freshness; they were fixed
because they sat directly in the files this issue's implementation and
verification needed, per the same standard applied to the #1517 PR (where an
adjacent instance of the first bug was flagged but left for a human call —
this time, fixing it was confirmed explicitly before proceeding).
