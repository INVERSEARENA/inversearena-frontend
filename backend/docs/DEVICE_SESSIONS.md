# Authenticated Device Sessions (#1410)

## Ownership

- **AuthService** (`src/services/authService.ts`) owns session lifecycle:
  `listSessions`, `revokeSession`, and the existing `revokeAllSessions`.
- A **session** is a refresh-token family (`familyId`) — the unit that was
  already used for reuse-detection/rotation before this feature. Each row in
  `RefreshTokenModel` for a family now also carries `accessJti`, `refreshJti`,
  `deviceLabel`, and `ip`, captured at login and carried forward across
  rotations.
- **SessionStore** (Redis) remains the fast-revocation index, keyed by JTI —
  unchanged. Per-session revoke now has, for the first time, a way to find
  exactly which two JTIs belong to a given family.

## State transitions

A session is "active" (listable) while its current (`used: false`) refresh
row is `revoked: false` and unexpired. Revoking one:

1. Loads the current row for `{ userId, familyId }` — 404s if it doesn't
   exist or belongs to a different user (IDOR guard).
2. Marks every row in that `familyId` `revoked: true`.
3. Removes `accessJti` and `refreshJti` for that family from Redis.

No other family's DB rows or Redis JTIs are touched — this is the whole
mechanism behind "revoking one session invalidates its refresh chain without
logging out other devices."

## Failure behavior

- Revoking an unknown or foreign `familyId` returns 404 (not 403), matching
  the existing `canAccessTransaction` convention of not distinguishing
  "missing" from "forbidden."
- Rows written before this feature existed have no `accessJti`/`refreshJti`;
  `revokeSession` tolerates their absence (skips the Redis removal step)
  rather than throwing.

## Compatibility

Additive: two new endpoints (`GET`/`DELETE /api/auth/sessions[...]`) and new
optional fields on the `RefreshTokenModel` schema. `POST /api/auth/verify`'s
request/response shape is unchanged — device metadata is derived server-side
from the `User-Agent`/IP of the request, not supplied by the caller.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/auth/sessions` | Lists this user's active sessions; each entry flags `current: true` for the caller's own session |
| `DELETE` | `/api/auth/sessions/:familyId` | Revokes exactly one session |
| `DELETE` | `/api/auth/sessions` | Pre-existing: revokes *every* session for the wallet |

## Frontend status

The backend endpoints are complete and tested. The frontend does not yet call
`POST /api/auth/verify` anywhere (wallet-signature login isn't wired into the
UI) — that is a pre-existing gap, not something this feature introduces, so
there's no working end-to-end "view/revoke my devices" screen yet.
