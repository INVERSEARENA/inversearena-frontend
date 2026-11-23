# Arena Stats API Documentation

This document describes the `/api/arenas/:id/stats` endpoint.

## Endpoint

`GET /api/arenas/:id/stats`

Returns real-time and historical statistics for a specific arena.

### URL Parameters

- `id` (string): The UUID of the arena.

### Response Schema

The response is a JSON object with the following fields:

| Field           | Type   | Description                                                             |
| :-------------- | :----- | :---------------------------------------------------------------------- |
| `arenaId`       | string | The unique identifier of the arena.                                     |
| `currentPot`    | number | Total stake amount in the current round.                                |
| `playerCount`   | number | Total number of players who joined the arena.                           |
| `survivorCount` | number | Number of players currently remaining in the game.                      |
| `currentRound`  | number | The current round number (1-indexed).                                   |
| `entryFee`      | number | The minimum stake required to join the arena.                           |
| `yieldAccrued`  | number | Total yield accrued from resolved rounds.                               |
| `status`        | string | Current state of the latest round (e.g., "open", "closed", "resolved"). |
| `lastUpdated`   | string | ISO 8601 timestamp of when the stats were last calculated.              |
| `degraded`               | boolean       | See [Degraded mode](#degraded-mode-1408) below.                |
| `ledgerSequence`         | number \| null | Soroban ledger the on-chain fields (`playerCount`, `yieldAccrued`, `status`) were verified at, or `null` if no on-chain read has ever succeeded for this arena. |
| `snapshotVerifiedAt`     | string \| null | ISO 8601 timestamp matching `ledgerSequence`, or `null` under the same condition. |

### Example Response

```json
{
  "arenaId": "550e8400-e29b-41d4-a716-446655440000",
  "currentPot": 1250.5,
  "playerCount": 100,
  "survivorCount": 42,
  "currentRound": 3,
  "entryFee": 10.0,
  "yieldAccrued": 15.75,
  "status": "open",
  "lastUpdated": "2026-02-25T17:45:00.000Z",
  "degraded": false,
  "ledgerSequence": 559284,
  "snapshotVerifiedAt": "2026-02-25T17:44:58.000Z"
}
```

### Degraded mode (#1408)

`playerCount`, `yieldAccrued`, and `status` are read from the arena's Soroban
contract in a single all-or-nothing call. When that call succeeds,
`degraded` is `false` and the response reflects the live chain state as of
`ledgerSequence`.

When Soroban RPC is unreachable (or the shared circuit breaker has tripped
open), the endpoint falls back to the **last verified snapshot** of those
three fields — cached for up to 24h from the last successful live read —
and sets `degraded: true`. `ledgerSequence`/`snapshotVerifiedAt` always
describe when that data was actually true on-chain, so a caller can tell
"live" from "stale" and never mistakes one for the other. If no live read
has ever succeeded for an arena, the response falls back further to
DB-derived values with `degraded: false, ledgerSequence: null` — this
matches the endpoint's pre-#1408 behavior exactly and is not a new failure
mode.

`currentPot`, `entryFee`, `maxPlayers`, `joinDeadline`, and `currentRound`
are always DB-derived and are not affected by degraded mode.

### Error Responses

- **404 Not Found**: Returned if the arena ID does not exist.
  ```json
  {
    "error": "Arena with ID <id> not found"
  }
  ```
- **500 Internal Server Error**: Unexpected server errors.
