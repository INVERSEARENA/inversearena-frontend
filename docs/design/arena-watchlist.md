# Arena Watchlist Synchronized to Authenticated Profiles (#1402)

## Ownership and state

`WatchlistService` (backend) owns watch/unwatch enforcement: arena-id
validation against the real Postgres `Arena` table via Prisma, the
200-arena cap, and idempotency. `UserModel.watchedArenaIds` (Mongoose —
the same document that already holds `displayName`/`aliasHistory`, and
the document `req.user.id` actually addresses; the Prisma `User` table is
a separate table used only for transaction/elimination-log foreign keys,
confirmed by tracing `authService.ts`'s session issuance) is the
persisted state. A watchlist entry is a plain Prisma arena id string with
no foreign-key relationship into Postgres — a later-deleted arena just
becomes a dangling id, which is the caller's problem to resolve when
reading arena details, not this model's.

State is a deduplicated set, not an ordered log: `$addToSet`/`$pull`
Mongo operators mean two concurrent watch calls for the same arena from
two devices can never produce a duplicate entry.

## Failure and compatibility

Watch/unwatch are both idempotent by construction: watching an
already-watched arena, or unwatching an absent one, is a successful
no-op that returns the current list unchanged, never a 409/404 for that
specific case. Watching a genuinely nonexistent arena still 404s
(`ARENA_NOT_FOUND`) — idempotency covers repeat operations, not invalid
input. New field, new endpoints (`GET/PUT/DELETE /api/users/me/watchlist[/:arenaId]`)
— no existing REST surface changes.

`routes/watchlist.ts` is a standalone module (mounted from
`routes/users.ts`) rather than inline in that file, for the same reason
`routes/arenaTime.ts` is standalone: `users.ts` already imports
`ActiveStakeLimitsService`, whose import of two metrics that do not exist
in `utils/metrics.ts` (`activeStakeLimitBlockedTotal`,
`activeStakeCurrentGauge` — confirmed pre-existing and unrelated to this
change) fails `tsc --noEmit` and blocks any test that imports
`routes/users.ts` as a whole.

## Observability

`inversearena_watchlist_operations_total{operation,result}` counts every
watch/unwatch call by outcome (`added`/`noop`/`limit_exceeded` for watch;
`removed`/`noop` for unwatch). Structured log events
(`arena_watched`/`arena_unwatched`) are emitted only on an actual state
change, not on idempotent no-ops, so log volume tracks real user activity
rather than every repeat click.

## Edge cases covered

- Watch/unwatch idempotency (repeat calls, both directions).
- Watching a nonexistent arena.
- Watching for a nonexistent user.
- The 200-arena cap.
- Per-user isolation (one user's watchlist never affects another's).
- Cross-device persistence: since the watchlist lives entirely
  server-side keyed by the authenticated user id, a second independent
  request under the same identity (simulating a different device) sees
  the same state with no client-side sync logic required.
- Frontend: optimistic toggle reconciled with the server's actual
  (idempotent) result rather than trusted blindly, and rolled back on a
  failed request.
