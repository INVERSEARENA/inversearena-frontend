# Design note: schema-level limits for untrusted metadata and event payloads (#1455)

## Problem

Several free-form values were persisted without any size bound:

- Prisma JSON columns: `Arena.metadata` and `Round.metadata`
  (`playerChoices`, `resolution`).
- The Mongo `Mixed` field `AuditLog.metadata`, filled from whatever a handler
  puts in `res.locals.auditMetadata`.
- Loose strings in route schemas: `txHash`/`failureReason` on cancellation
  recovery, `pushToken`/`email` on notification preferences, and the
  invitation `code`.
- On-chain: `configure_leaderboard_limit(u32)` accepted any value, including
  `0` and `u32::MAX`. The limit controls how large the persistent
  `Leaderboard` vector can grow.

## Ownership

- Backend: `backend/src/validation/payloadLimits.ts` owns the limits
  (`PAYLOAD_LIMITS` for each boundary, and `STRING_LIMITS`) and the checks.
- Contracts: the constants live next to the types they bound.
  `contract/arena/src/types.rs` holds `MAX_LEADERBOARD_LIMIT` and
  `validate_leaderboard_limit`. `contract/factory/src/types.rs` holds
  `MAX_ARENAS_PAGE_SIZE` and `clamp_page_size`.

## Mechanism

`findPayloadLimitViolation(value, limits)` walks the value iteratively, with
no recursion, so very deep input cannot overflow the stack. It stops at the
first limit broken: depth, string or key length, array length, number of
object keys, total node count, or a non-JSON type. The node budget caps the
work for any input.

| Boundary | Where it is enforced | On violation |
|---|---|---|
| Request metadata (`boundedMetadataSchema`) | Zod `superRefine` | 400 `VALIDATION_ERROR` with the issue path |
| `arena_metadata` | `ArenaService` before `prisma.arena.create` | `PayloadLimitError` (413 `PAYLOAD_LIMIT_EXCEEDED`), nothing written |
| `round_metadata` | `RoundRepository.toJsonMetadata` before `update`/`create` | 413, nothing written |
| `audit_metadata` | `auditLogMiddleware` before `AuditLogModel.create` | metadata replaced by `{truncated, limit, path}`; the audit entry is **still written** |
| arena `configure_leaderboard_limit` | contract | `ArenaError::InvalidLeaderboardLimit` (38), nothing persisted |
| factory `get_arenas` | contract | `limit` clamped to 50 (read-only, same ABI behaviour as before) |

Limits are checked before the write, so a rejected payload never leaves a
partial write behind. If the same oversized payload is delivered twice, it is
rejected the same way both times.

## Observability

- Metric `inversearena_payload_limit_rejections_total{boundary,limit}`.
- A structured log `event=payload_limit_rejected` records the boundary, kind,
  path, limit and actual size. It never includes the payload itself.

## Compatibility

- The `round_metadata` limits are sized above the existing `RoundInputSchema`
  maximum of 500 players, so no valid round is rejected.
- `ArenaError::InvalidLeaderboardLimit = 38` is **appended**. No existing
  ordinal changes. `configure_leaderboard_limit` values 1–100 behave as
  before. Values outside that range used to be stored silently and are now
  rejected.
- The factory's page-size constant moved from `lib.rs` to `types.rs` and was
  renamed `MAX_ARENAS_PAGE_SIZE`. Its value (50) is unchanged.
- `refundAmount` must now be finite and non-negative. Nothing sensible
  depended on negative or `Infinity` refunds.
