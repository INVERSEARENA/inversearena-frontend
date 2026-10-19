# Degraded-Mode Arena Reads (#1408)

See [ARENA_STATS_API.md](./ARENA_STATS_API.md) for the response schema. This
note covers ownership/design; that one covers the field-level API contract.

## Ownership

- **onChainReader.getOnChainSnapshotOrThrow** owns the *live* read: player
  count, game state, and total yield in one all-or-nothing Soroban call. It
  throws on any failure — unlike its sibling
  `getOnChainPlayerCount`/`getOnChainGameState`/`getOnChainTotalYield`
  (unchanged, still used by `portfolioExposureService`), which intentionally
  default to a safe value on failure and are not part of this feature.
- **ledgerClock** (shared with #1399) owns reading the current ledger
  sequence that stamps a snapshot.
- **ArenaStatsService** owns the degrade/cache decision: attempt live, fall
  back to the last verified snapshot (cached via `cacheService`), fall back
  further to the pre-#1408 DB-derived values if nothing was ever verified.

## State transitions

There is no persisted "degraded" flag — every call to `getArenaStats`
independently attempts a live read and only falls back on failure:

```
live read succeeds        -> degraded: false, cache the snapshot (24h TTL)
live read fails, cache hit -> degraded: true,  serve the cached snapshot
live read fails, cache miss -> degraded: false, ledgerSequence: null (DB fallback, pre-#1408 behavior)
```

The live attempt is wrapped in the shared Soroban circuit breaker, so a
sustained outage fails fast instead of retrying per-request.

## Failure behavior

The three on-chain-sourced fields (`playerCount`, `yieldAccrued`, `status`)
move **together** — either all three are live, or all three are the same
verified snapshot, or all three are DB-derived. Before this feature, each
field failed independently and fell back silently, so a partial RPC hiccup
could mix live and stale data with no signal to the caller. `degraded` and
`ledgerSequence` make that mix impossible and disclose staleness whenever it
happens — the response never presents old data as live.

## Compatibility

Additive fields only (`degraded`, `ledgerSequence`, `snapshotVerifiedAt`) on
`GET /api/arenas/:id/stats`. No existing field changes meaning or type.
`currentPot`, `entryFee`, `maxPlayers`, `joinDeadline`, `currentRound` are
unaffected — they were always DB-derived.
