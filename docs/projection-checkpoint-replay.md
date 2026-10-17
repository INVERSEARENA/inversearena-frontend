# Canonical Arena Projection: Checkpointed Replay (#1382)

This document describes the checkpointed on-chain arena projection: a
derived, queryable read-model built by replaying the `ArenaContract`'s
on-chain event log (see [`event-schema.md`](./event-schema.md)) in order,
with the ability to resume from a saved checkpoint instead of always
replaying from genesis.

It does **not** replace the existing DB-backed `ArenaService.getSnapshot()`
read path (rounds/eliminations written by the round-resolution flow) or the
SSE fan-out poller in `backend/src/cache/arenaPoller.ts`, which continues to
read from that same DB state unchanged. This is a new, additive subsystem.
See "Relationship to existing reads" and "Compatibility constraints" below.

## Scope note: relationship to #1391 (arena discovery backfill)

#1391 is about discovering **which arenas exist** that the backend missed
(factory-level `create_pool` events it never indexed). This issue (#1382) is
about the **state projection** for arenas the backend already knows about:
given an arena's contract ID, deterministically derive its full read-model
from the arena's own event stream, resumable from a checkpoint. The two are
independent — #1391 decides *which* `arenaId`s to project; #1382 decides
*how* a single arena's projection is built and kept correct. Nothing here
depends on #1391 shipping, and nothing here discovers new arenas.

## What already existed vs. what was built

Before this change, `arenaPoller.ts` had **no checkpoint concept at all**.
It is a per-arena in-memory SSE fan-out loop: it polls
`ArenaService.getSnapshot()` (a DB query joining `arenas`/`rounds`/
`elimination_logs`) on a fixed interval and diffs the result against
in-memory `lastRoundState`/`lastStatus`/`seenEliminations` fields to decide
which SSE events to emit. It never reads on-chain events, never tracks a
ledger sequence, and holds no persisted position — restarting the process
just starts polling again from whatever is currently in Postgres. There was
nothing to extract a "checkpoint" from because there was no event replay
loop to begin with.

Likewise, `onChainReader.ts` only wrapped read-only **view function**
simulation calls (`game_state`, `get_players`, `get_winner`,
`get_total_yield`) — it had no `getEvents` integration, i.e. no way to read
the contract's *event log* at all, only its *current state*.

This meant the projection/replay/checkpoint machinery described below is
new, greenfield work; there was no existing fold logic to extract or
refactor, and no existing checkpoint schema to build on beyond an empty
slate.

## Ownership

| Concern | Owner |
|---|---|
| Decoding raw Soroban RPC events into typed `ArenaProjectionEvent`s | `backend/src/services/onChainReader.ts` (`toArenaProjectionEvent`, `getArenaEvents`) |
| The canonical fold (event ⊕ state → state) | `backend/src/services/projection/arenaProjectionFold.ts` — the **single enforced implementation**; no other module may re-derive projected arena state from events |
| Checkpoint persistence (read/write/lease) | `backend/src/services/projection/arenaProjectionCheckpointStore.ts`, backed by the `ArenaProjectionCheckpoint` Prisma model |
| Orchestrating replay (genesis-or-checkpoint → paginated fetch → fold → checkpoint) | `backend/src/services/projection/arenaProjectionReplay.ts` |
| Serving the projection to API/consumer code | `backend/src/services/arenaService.ts` (`ArenaService.getProjection`) — additive; does not change `getSnapshot()` |
| Metrics/structured logs for the replay path | `backend/src/services/projection/arenaProjectionMetrics.ts` + `logger` from `backend/src/utils/logger.ts` |

No other module is permitted to fold arena events into state. Anything that
needs projected arena state calls `ArenaService.getProjection` (or, for
lower-level use, `replayArenaProjection` directly) rather than
re-implementing the fold.

## State machine

The replay engine for a given `(arenaId, network)` moves through these
states, persisted in `ArenaProjectionCheckpoint.status`:

```
        no checkpoint row                 checkpoint row exists
              │                                    │
              ▼                                    ▼
         ┌─────────┐                          ┌─────────┐
         │  idle   │ ───────────────────────► │  idle   │
         └────┬────┘      (after a run         └────┬────┘
              │             completes/fails)         │
              │ startReplay()                        │ startReplay()
              ▼                                       ▼
        ┌───────────────────────────────────────────────┐
        │                  replaying                     │
        │  fetch next batch of events (paginated,         │
        │  bounded by ARENA_REPLAY_BATCH_SIZE) from        │
        │  onChainReader.getArenaEvents, starting at        │
        │  checkpoint.lastLedgerSequence + 1 (or genesis     │
        │  ledger if no checkpoint) → fold each batch with    │
        │  foldArenaProjectionEvents → persist checkpoint       │
        │  (new lastLedgerSequence + projectionState) after    │
        │  EACH batch commits                                   │
        └───────────────────────┬────────────────────────────┘
                                 │
                 more events remain?
                 ┌───────yes─────┴───────no────────┐
                 ▼                                  ▼
           (loop: fetch next batch)           ┌────────────┐
                                               │ caught_up  │
                                               └─────┬──────┘
                                                     │ new events observed later
                                                     │ (poller/consumer calls
                                                     │  startReplay again)
                                                     ▼
                                               back to `replaying`

        Any unrecoverable error during a batch (RPC failure after
        retries exhausted, corrupt checkpoint row) →
                                               ┌────────────┐
                                               │   failed   │  (lastError set;
                                               └─────┬──────┘   checkpoint NOT
                                                     │           advanced past
                                        next startReplay()       last good batch)
                                                     │
                                                     ▼
                                               back to `replaying`,
                                               resuming from the last
                                               successfully committed
                                               checkpoint
```

Key invariant: **the checkpoint is only advanced after a batch has been
fully folded and the resulting projection state has been durably written.**
There is no state where the in-memory projection is "ahead of" its own
recorded checkpoint in a way that would be lost or duplicated on restart —
see "Failure behavior" below.

"Caught up / live following": once a replay pass finds no further events
past its own watermark, the engine marks the checkpoint `caught_up`. This
codebase's existing live-update mechanism is the SSE poller
(`arenaPoller.ts`), which is untouched by this change; nothing here
currently invokes `startReplay` on a timer. A follow-up (left as an
explicit open question below) could have the poller or a scheduled job
call `startReplay` periodically to keep the projection near-live. For this
issue, the replay engine is invoked on demand (e.g. from `getProjection`
when the checkpoint is missing/stale, or from tests/tooling); wiring a
recurring trigger is out of scope but designed to be a trivial follow-up
(call `startReplay` on the same interval the poller already uses).

## Failure behavior

- **Malformed event during replay**: `onChainReader.toArenaProjectionEvent`
  never throws — an event whose topic isn't in `ARENA_EVENT_TOPICS`, or
  whose payload fails to decode, becomes an `ArenaUnknownEvent`
  (`topic: "UNKNOWN"`). `foldArenaProjectionEvent` folds this by recording
  the event id in `skippedEventIds` and advancing `lastLedgerSequence`
  without touching interpreted state, so a single bad event cannot halt
  replay or corrupt the projection. It is logged at `warn` with the event id
  and raw topic for operator visibility (`arenaProjectionReplay` logs,
  `subsystem: "arena-projection"`).
- **Corrupted/missing checkpoint row**: "missing" is a normal case — it
  means "replay from genesis" and is handled by
  `initialArenaProjection(arenaId)`. A "corrupted" row (the `projectionState`
  JSON fails to parse into the expected shape) is treated as
  **unrecoverable for resume**: the replay engine logs an error, marks the
  checkpoint `failed` with `lastError` describing the shape mismatch, and
  refuses to silently fall back to genesis (that would replay everything
  again under a *different* in-memory state than what was checkpointed,
  which is exactly the failure mode the equivalence test guards against).
  Recovery requires an operator to either fix the row or explicitly delete
  it (which is a deliberate, auditable "replay from genesis" decision, not
  an automatic one).
- **Interrupted replay (crash mid-batch)**: because checkpoints are only
  written after a batch's fold completes, an interrupted batch simply never
  got committed — on restart, `startReplay` reads the last good checkpoint
  and re-fetches starting at `lastLedgerSequence + 1`, re-fetching and
  re-folding the same batch it was working on when it crashed. This is safe
  because folding is idempotent per event id (`appliedEventIds`/
  `skippedEventIds` dedupe in `foldArenaProjectionEvent`) — re-folding a
  batch that was partially applied in memory (but never checkpointed) simply
  reproduces the same state deterministically.
- **Concurrent replay processes**: guarded by an advisory lease
  (`leaseOwner` + `leaseExpiresAt` on `ArenaProjectionCheckpoint`).
  `startReplay` atomically claims the lease via a conditional
  `updateMany` (`WHERE (leaseOwner IS NULL OR leaseExpiresAt < now())`) before
  proceeding; if the claim affects zero rows, another process holds an
  active lease and `startReplay` returns a `LeaseHeldError` immediately
  rather than racing. The lease has a short TTL
  (`ARENA_REPLAY_LEASE_MS`, default 60s) and is renewed after each batch, so
  a crashed holder's lease expires and a new process can take over rather
  than requiring manual intervention.
- **Stale reads (query during replay)**: `ArenaService.getProjection`
  reads whatever checkpoint row currently exists, tagging the response with
  `status` (`idle | replaying | caught_up | failed`) and
  `lastLedgerSequence`, so callers can see they're reading a
  possibly-in-progress projection rather than treating every read as
  final/authoritative. This mirrors the existing pattern where
  `OnChainReadError` (in `onChainReader.ts`) forces callers to distinguish
  "no value" from "read failed" — here we similarly refuse to hide
  "still replaying" behind a response that looks identical to "caught up".

## Compatibility constraints

- `ArenaService.getSnapshot()` (used by `arenas.ts` routes and
  `arenaPoller.ts`) is **unchanged** — same method signature, same return
  shape. The projection is exposed via a new `ArenaService.getProjection()`
  method; no existing REST response shape changes.
- The `ArenaProjectionCheckpoint` Prisma model is new; it does not alter any
  existing table. Migration:
  `backend/prisma/migrations/20260924083748_add_arena_projection_checkpoint/migration.sql`.
- `ArenaProjectionState` (the JSON shape stored in `projectionState` and
  returned by `getProjection`) is a new, versioned shape. If its fields ever
  change in a way that isn't purely additive, the stored JSON must carry an
  explicit `schemaVersion` field and readers must handle old versions
  (not yet needed — `schemaVersion` is reserved as `1` implicitly via the
  fold module's version comment, and should be added explicitly the first
  time the shape changes).
- `ARENA_EVENT_TOPICS` in `arenaEventTypes.ts` mirrors `docs/event-schema.md`
  exactly (`INIT`, `CFGD`, `START`, `FINISH`, `JOIN`, `CHOICE`, `ELIM`,
  `CLAIMED`, `RWAYLD`). If the contract's ABI/event set changes, both this
  doc and `event-schema.md` must be updated together, and unknown topics
  degrade gracefully (see "Failure behavior") rather than breaking replay.
- No changes were made under `contract/` and nothing was deployed to
  testnet/mainnet as part of this work.

## Determinism contract (the core acceptance criterion)

`foldArenaProjectionEvent`/`foldArenaProjectionEvents` are pure functions:
`(state, event) → state` with no I/O. This gives us the property the issue
requires:

```
fold(fold(fold(initial, e1), e2), e3)               // genesis replay
  ==
fold(fold(checkpointAfter(initial, e1, e2)), e3)     // checkpoint replay,
                                                      // for ANY split point
```

because folding only ever reads its two arguments and returns a new state —
it has no hidden dependency on *how* the input state was produced (from
genesis or from a resumed checkpoint). The replay engine's job is just to
feed the same events, in the same order, into the same fold — whether the
starting `state` came from `initialArenaProjection` or from a deserialized
checkpoint row makes no difference to the function itself.

This is verified directly (not just asserted) by
`arenaProjectionEquivalence.unit.test.ts`, which builds a projection from
genesis through N synthetic events, separately checkpoints after a prefix
and replays the remainder, and asserts `toEqual` (deep equality) between the
two final states — including `appliedEventIds`/`skippedEventIds`, not just
the "visible" fields, so the equivalence claim covers the full state, not a
cherry-picked subset.

## Idempotency / duplicate delivery

Soroban RPC's `getEvents` (like most at-least-once event sources) does not
guarantee exactly-once delivery across retried/paginated requests, and the
replay engine may itself re-fetch a batch after a crash (see "Interrupted
replay" above). `foldArenaProjectionEvent` treats an event id already
present in `appliedEventIds` or `skippedEventIds` as a no-op, so folding the
same event twice — whether from a real duplicate delivery or from
re-fetching after an interrupted batch — cannot double-count a join,
elimination, or yield amount. This was a deliberate design choice over
de-duplicating in the replay engine's I/O layer: keeping idempotency inside
the fold itself means every caller (genesis replay, checkpoint replay,
tests) gets it for free without needing to remember to de-duplicate
upstream.

Trade-off acknowledged: `appliedEventIds`/`skippedEventIds` grow with the
arena's full event history and are kept in the checkpoint snapshot. For this
domain (bounded per-arena event count — joins/choices/eliminations per
player per round, plus a handful of lifecycle events) this is a small,
bounded list, not a scaling concern. If arenas were long-lived and
high-frequency (unbounded event volume), a separate bounded dedupe
structure (e.g., a sliding window or a dedicated dedupe table keyed by event
id) would be the better trade-off — noted here rather than built
speculatively, per "engineered enough."

## Edge cases handled

| Edge case | Handling |
|---|---|
| Duplicate event delivery | Idempotent fold via `appliedEventIds`/`skippedEventIds` (see above) |
| Stale reads (query during replay) | `getProjection` surfaces `status`/`lastLedgerSequence` so callers can detect in-progress replay |
| Partial failure (batch fails mid-fetch) | Checkpoint only advances after a batch fully folds; a failed batch leaves the last good checkpoint intact |
| Restart during work | Resumes from last committed checkpoint; safe due to idempotent fold (see "Interrupted replay") |
| Network mismatch (testnet/mainnet) | `ArenaProjectionCheckpoint` is unique on `(arenaId, network)`; `network` is derived from `getStellarConfig().networkPassphrase`, never hardcoded, so testnet/mainnet checkpoints cannot collide or be read cross-network |
| Maximum-size input (large replay ranges) | `getArenaEvents` is paginated via the RPC `cursor`, bounded by `ARENA_REPLAY_BATCH_SIZE` (default 1000) per fetch; the replay loop processes and checkpoints one bounded batch at a time rather than loading an unbounded event range into memory |
| Concurrent replay processes | Advisory lease (`leaseOwner`/`leaseExpiresAt`) claimed via conditional `updateMany`; a second concurrent `startReplay` for the same `(arenaId, network)` gets `LeaseHeldError` rather than racing |

## Metrics / structured logs

All emitted with `subsystem: "arena-projection"` via the shared `logger`
(`backend/src/utils/logger.ts`), and counters/histograms registered on the
shared prom-client `Registry` (`backend/src/utils/metrics.ts`) so they're
served by the existing `/metrics` endpoint alongside round/payout metrics.
See `backend/src/services/projection/arenaProjectionMetrics.ts`:

- `inversearena_projection_replay_total{result="success"|"failure"}` — counter
- `inversearena_projection_replay_duration_seconds` — histogram (per full `startReplay` call, genesis-or-checkpoint through caught_up/failure)
- `inversearena_projection_replay_batches_total{result="success"|"failure"}` — counter (per-batch granularity, since a multi-batch replay's failure point matters operationally)
- `inversearena_projection_replay_retries_total` — counter (RPC retry attempts inside a batch fetch)
- `inversearena_projection_events_folded_total{topic}` — counter, labeled by event topic (including `"UNKNOWN"`) for visibility into event mix and skip rate
- `inversearena_projection_lease_conflicts_total` — counter (attempts that found an active lease)

Structured logs (pino, `logger.info`/`warn`/`error`) are emitted at replay
start, per-batch completion (ledger range, event count, duration), replay
completion (`caught_up` or `failed` with `lastError`), and lease conflicts —
each carrying `arenaId`, `network`, and `subsystem: "arena-projection"` so
they can be correlated with the existing Sentry/pino request-id tagging
already used elsewhere in this backend (`contextLogger`).

## Open questions / follow-ups (flagged, not resolved by this change)

1. **Who calls `startReplay` on a schedule?** This issue builds the replay
   engine and its checkpoint mechanism; it does not wire a cron/interval
   trigger. `arenaPoller.ts`'s existing 2.5s DB-poll loop was deliberately
   left untouched (it serves the existing `getSnapshot()` REST/SSE
   contract). The most natural follow-up is a small scheduled job (or an
   opt-in call from the poller) invoking `startReplay` per known arena on an
   interval — left out here to avoid entangling a new subsystem with the
   existing poller's behavior under a "High complexity, single issue" scope.
2. **Genesis ledger lower bound**: `getArenaEvents` needs a `startLedger`
   for genesis replay. Soroban RPC only retains events for a limited
   window (typically ~7 days on pubnet); for an arena older than the
   retention window with no checkpoint, genesis replay cannot reach true
   contract-genesis. This is a Soroban RPC platform constraint, not
   something this backend can work around — documented as a known
   limitation. Arenas are checkpointed as they're replayed, so this only
   bites an arena that (a) is older than the RPC retention window and
   (b) has never been checkpointed. New arenas created after this feature
   ships are unaffected as long as replay runs before the retention window
   elapses.
