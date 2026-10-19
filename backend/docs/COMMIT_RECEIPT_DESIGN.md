# Commit Receipt — Design Note

Issue: #1383 "Add round-scoped commit receipt endpoint and player status view"

This note defines the design for a new read endpoint that lets a player check
the status of their `submit_commitment` transaction for a specific round,
before that round's commit window closes. It is written before implementation
per the issue's acceptance criteria (ownership, state transitions, failure
behavior, compatibility).

## 1. Background: what "commit" means in this codebase

Inverse Arena rounds use a commit-reveal scheme, not a single-step
"submit_prediction" call:

1. `submit_commitment(player, commitment)` — the player hashes their choice
   (`Heads`/`Tails`) with a random 32-byte salt client-side
   (`frontend/src/shared-d/utils/commit-reveal.ts`), and submits only
   `SHA256([choice_byte] ++ salt)` on-chain
   (`contract/arena/src/lib.rs:356`). The salt itself is never sent on-chain
   and is persisted **only in the browser's `localStorage`**
   (`saveCommitment`/`loadCommitment`), keyed by `arenaId:round:publicKey`.
2. `reveal_choice(player, choice, salt)` — after the round's
   `commit_deadline` has passed, the player reveals the original choice +
   salt; the contract recomputes the hash and checks it against the stored
   commitment.

The contract enforces a single per-round window via
`ArenaConfig.commit_deadline: u64` (a ledger timestamp,
`contract/arena/src/types.rs:60`), set by `start_round(duration_seconds)`
(`contract/arena/src/lib.rs:583`). `submit_commitment` is rejected with
`CommitPhaseEnded` once `env.ledger().timestamp() >= commit_deadline`
(`lib.rs:367`).

**There is no on-chain getter for "has address X submitted a commitment for
round N?"** `ArenaStorage::save_commitment` / `load_commitment`
(`contract/arena/src/storage.rs:185`) are private storage helpers, not
exposed via `#[contractimpl]`. The only observable signal is the
`commitment_submitted` event (topic `"commit"`,
`contract/arena/src/events.rs:131`), which carries the player address and
round number but not the commitment hash itself.

**The backend does not index `submit_commitment` at all today.** Searching
the backend for any consumer of the `commit`/`commitment_submitted` event or
any write path that records a per-round, per-player "commit seen" row found
none. The only place a player's round choice enters Postgres is
`RoundMetadata.playerChoices` (`backend/src/types/round.ts:51`), which is
populated by `RoundService.resolveRound` (`backend/src/services/roundService.ts:150`)
— i.e. **after** the round has already been resolved on-chain (post-reveal,
post-tally), from the `RoundInput.playerChoices` the caller of
`POST /api/admin/rounds/resolve` supplies. Before resolution, the `Round` row
in Postgres (`backend/prisma/schema.prisma:50`) has no field that reflects
who has committed. It also has no `commit_deadline`/window-close timestamp of
its own — round OPEN → CLOSED transitions happen via the admin-only
`POST /api/admin/rounds/:id/close` (`roundService.closeRound`), not on a
timer the backend tracks.

This matches the issue's framing exactly: a player who calls
`submit_commitment` today has no way to ask the backend "did that land?"
before the round locks — they can only trust their own wallet's transaction
result and wait for the round to resolve.

## 2. Ownership

`RoundService` (`backend/src/services/roundService.ts`) owns commit-receipt
status. It already owns round lifecycle (`resolveRound`, `closeRound`) and is
the only service that reads `RoundMetadata.playerChoices`. A new
`getCommitStatus(arenaId, roundNumber, walletAddress)` method is added there rather than
inline in the route handler, matching the existing separation in
`arenas.ts` where routes stay thin and delegate to services
(`ArenaService`, `ArenaStatsService`, `RoundRepository`).

`RoundRepository` gains no new query — `getCommitStatus` uses
`findByArenaAndNumber`, which it already exposes and already backs
`GET /:id/rounds/:roundNumber` (see `roundRepository.ts`).

## 3. The four-state model

Given there is no backend-side record of an in-flight/pending on-chain
commit (see §1), the four states are derived **entirely from data the
backend already has**: `Round.state` and `Round.metadata.playerChoices`.
This is the conservative, explicitly-flagged design choice called out in the
task: it does not invent a new "seen but unconfirmed" indexing pipeline,
because no such pipeline exists today and building one (an event listener
for `commitment_submitted`, a new table, a reconciliation job) is out of
scope for a "bounded vertical slice" per the issue's stated scope, and would
duplicate work already flagged as a real gap (§7, open questions).

| State | Condition | Meaning |
|---|---|---|
| `accepted` | `round.state` is `RESOLVED` or `SETTLED` **and** `walletAddress` appears in that round's stored `playerChoices` (via the player's `User.walletAddress` → `userId` mapping) | The player's revealed choice was recorded when the round resolved. This is the only state the backend can assert with on-chain-equivalent confidence, because `playerChoices` is written from the same `RoundInput` that drives `resolve_round`. |
| `pending` | `round.state` is `OPEN` (commit window still open, by the backend's own state — see caveat below) **and** the player has no resolved choice yet | The window has not closed from the backend's point of view. The backend cannot distinguish "player hasn't submitted yet" from "player submitted on-chain moments ago and it just isn't reflected here" — both collapse to `pending` because there is no indexed signal in between (§5, stale reads). |
| `expired` | `round.state` is `CLOSED` (window closed by an explicit `closeRound` call) **and** the player has no resolved choice for that round | The round moved past commit phase without a recorded choice for this player. Note `CLOSED` is a real intermediate DB state distinct from `RESOLVED` — a round can sit `CLOSED` for a while before an admin/worker calls `resolveRound`, so `expired` can be returned before resolution, which is exactly the "distinguish before the round locks" requirement. |
| `missing` | The round does not exist, or exists but the player has no `User` record / never joined, or (fallback) none of the above conditions match | Absence, not a stored value — never written to the DB, always the default when no other signal applies. Also returned for a round with `roundNumber` that does not exist for the arena. |

State determination pseudocode (implemented in
`RoundService.getCommitStatus`):

```
round = roundRepo.findByArenaAndNumber(arenaId, roundNumber)
if round is null: return { status: "missing", reason: "ROUND_NOT_FOUND" }

user = prisma.user.findUnique({ walletAddress })
committed = user && round.playerChoices.some(c => c.userId === user.id)

if committed: return { status: "accepted", ... }
if round.state in [RESOLVED, SETTLED] and !committed: return { status: "missing", reason: "NO_COMMIT_RECORDED" }
if round.state == CLOSED and !committed: return { status: "expired" }
if round.state == OPEN and !committed: return { status: "pending" }
```

Note the `RESOLVED`/`SETTLED`-without-a-recorded-choice branch is `missing`,
not `expired`: once a round is resolved, "the window closed and you never
committed" and "you committed but the resolution data doesn't have you" are
indistinguishable from stored data alone, and `missing` is the more honest,
more conservative label — it does not imply the backend has any positive
evidence of a closed-but-uncommitted window the way `expired` (derived from
the explicit `CLOSED` transition) does.

### Why not use the on-chain `commit_deadline` timestamp directly?

`fetchArenaState` on the frontend (`frontend/src/shared-d/utils/stellar-transactions.ts:443`)
already has `commitDeadline: number | null` in `ArenaStateResponse`, but it
is hardcoded to `null` with a comment that `get_full_state` doesn't return it
yet — a pre-existing contract-level gap (#1330), not something this issue's
scope covers ("contract changes... flag clearly rather than assuming it's
fine" — flagged in §7). The backend also has no on-chain reader for
`commit_deadline` (`onChainReader.ts` only exposes `get_players`/
`get_winner`/`game_state`/`get_player_count`/`get_total_yield`). Since
neither side currently has this timestamp, `pending` vs `expired` is decided
from the backend's own `Round.state` (`OPEN` vs `CLOSED`), which is the
closest existing analogue to "is the commit window open" — set by the same
admin/worker action (`closeRound`) that in practice follows the on-chain
deadline. This is an approximation, not a live read of the contract's
`commit_deadline`; documented as an open question in §7.

## 4. Failure behavior

| Condition | Response |
|---|---|
| Arena does not exist | `404 ARENA_NOT_FOUND` (matches existing convention in `arenas.ts`, e.g. `/:id/rounds`) |
| Round number does not exist for the arena | `200` with `{ status: "missing", reason: "ROUND_NOT_FOUND" }` — a nonexistent round is a legitimate "no submission" answer for a status check, not a hard error, since the caller is asking "what's my status," not "does this resource exist." (`ARENA_NOT_FOUND` stays a 404 because the arena is the route's addressed resource; the round is a query input.) |
| Round exists, player never joined / no `User` record for the wallet | `200` with `{ status: "missing", reason: "NO_COMMIT_RECORDED" }` — same reasoning; asking about a wallet that never touched this arena is a valid, answerable query. |
| Malformed `roundNumber` (non-integer, negative, absurdly large) or malformed `id` (arena id, empty/oversized) | `400 VALIDATION_ERROR` via the existing Zod → `errorHandler` path (matches every other route in `arenas.ts`) |
| No authenticated caller (missing/invalid auth token) | `401 UNAUTHORIZED` — `walletAddress` is taken from `req.user.walletAddress` (set by `authMiddleware` from the verified JWT), never from client-supplied query/route input, so there is no separate "malformed walletAddress" input-validation case for this route: an invalid wallet format simply cannot reach this handler, since it would have already failed token verification upstream. |
| Backend's own read (Prisma) fails transiently | Falls through to the router's `asyncHandler` → `errorHandler`, which logs at `error` level and returns `500 INTERNAL_SERVER_ERROR` without leaking internals — same as every other route in this file. No special-casing: this endpoint does no on-chain calls itself (see §5), so there is no `OnChainReadError` class of failure to handle here. |
| Backend indexing lag / staleness | Not a hard failure — see §5. The response always includes `asOf` (server timestamp at query time) so the caller can reason about freshness explicitly rather than the endpoint claiming more certainty than it has. |

## 5. Compatibility

This is a **new, additive** endpoint:
`GET /api/arenas/:id/rounds/:roundNumber/commit-status`. It does not modify
any existing route's request or response shape, so no versioning is needed.
It reuses the existing `authMiddleware` pattern from `arenas.ts` (every
mutating/identity-bearing route in this file already requires it) and the
existing Zod validation / `asyncHandler` / `apiError` conventions.

It intentionally does **not** touch `fetchArenaState` /
`ArenaStateResponse` (the frontend's direct-to-Soroban-RPC simulation path)
— that function talks straight to the chain and is unrelated to this
backend REST surface; conflating the two would blur "on-chain simulated
state" with "backend-indexed record," which is exactly the ambiguity this
endpoint exists to resolve for the *backend's* view.

## 6. Edge cases (see also §7 open questions)

- **Duplicate delivery**: `playerChoices` is a plain array keyed by
  `userId`; `RoundService.resolveRound`'s `computePayouts`/elimination logic
  already reads it as at-most-one-entry-per-player from the resolution
  input, and the status lookup uses `.some(...)`, which is naturally
  idempotent — two identical entries still resolve to a single `accepted`.
- **Stale reads**: handled via the `asOf` field (§4) rather than a
  freshness guarantee the backend cannot make, since it does no on-chain
  read in this endpoint (see §7 on why "pending" cannot mean "seen in
  mempool").
- **Partial failure indexing a round's commits**: does not apply in the
  current data model — there is no per-commit indexing job to partially
  fail; `playerChoices` is written atomically as part of
  `RoundRepository.resolveAtomically`'s single transaction.
- **Restart during work**: the endpoint is a pure read with no side
  effects/writes, so a restart mid-request just drops the in-flight HTTP
  request; nothing to recover.
- **Network mismatch (testnet/mainnet)**: not applicable — this endpoint
  performs no Soroban RPC calls; it reads only from Postgres via
  `RoundRepository`/`prisma.user`, which is already network-scoped by
  whichever `DATABASE_URL` the backend process is running against, same as
  every other Prisma-backed route in this file.
- **Maximum-size / malformed input**: `roundNumber` is validated as
  `z.coerce.number().int().min(1).max(1_000_000)` and the arena `id` route
  param as `z.string().trim().min(1).max(200)`, both rejected with
  `400 VALIDATION_ERROR` before touching the database. `walletAddress` is
  not a request input at all for this route — it comes from
  `req.user.walletAddress`, populated by `authMiddleware` from the verified
  JWT (`backend/src/middleware/auth.ts`), which already encodes a
  well-formed Stellar account ID at token-issuance time (see `authService`).
  There is deliberately no separate `walletAddress` query/route param to
  validate here — accepting one would reopen the "probe an arbitrary
  wallet's status" concern noted in the route's own comment in `arenas.ts`.
- **Concurrent requests**: pure read, no shared mutable state, no
  additional caching layer introduced — safe by construction. (Deliberately
  not wrapped in `cacheMiddleware` — see §7.)

## 7. Open questions / flagged caveats

1. **No true "pending" signal exists.** Because the backend doesn't index
   `commitment_submitted` events, `pending` in this implementation means "the
   window is still open and we have no resolved record" — it cannot mean
   "we saw your transaction land but haven't confirmed it yet," which is
   what the issue's description literally suggests ("a transaction was seen
   in-flight"). Building that would require a new event-indexing worker
   (subscribing to `commitment_submitted`/topic `"commit"`) and a new
   Prisma table, which is a materially larger change than this endpoint and
   was treated as out of scope per the issue's own instruction not to
   "invent infrastructure that doesn't exist." Flagging this explicitly as
   the single biggest simplification in this design — a future
   `CommitReceipt` table + indexer would let `pending` be a real
   in-flight state instead of an inferred one, and would also make
   `expired` precise (compared against the actual on-chain
   `commit_deadline` instead of the backend's own `CLOSED` transition).
2. **`expired` is derived from `Round.state == CLOSED`, not from the
   on-chain `commit_deadline`.** If an admin closes a round late (well
   after the real on-chain deadline), players see `pending` for longer than
   the chain would allow new commits — the backend's notion of "window
   open" trails the contract's. This is pre-existing behavior (the same gap
   `arenaStatsService.ts`'s on-chain-first / DB-fallback pattern works
   around for other fields) and not introduced by this change, but it does
   mean this endpoint's `expired`/`pending` boundary is a backend-state
   proxy, not a chain-verified fact. Surfacing the real `commit_deadline`
   requires the contract's `get_full_state` (or a new getter) to actually
   return it, which is the same #1330 gap noted in §3 — a contract-adjacent
   follow-up, not something this issue should silently paper over.
3. **No caching**: `/rounds` and `/stats` use `cacheMiddleware`; this
   endpoint deliberately does not, because per-player status must not be
   served stale-for-someone-else out of a shared cache keyed loosely, and
   the query is already a cheap indexed lookup (`findByArenaAndNumber` +
   `findUnique` on `User.walletAddress`, both indexed). If load becomes a
   concern, a short TTL keyed by `(arenaId, roundNumber, walletAddress)`
   would be a safe follow-up.
