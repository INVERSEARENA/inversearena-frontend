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
  "lastUpdated": "2026-02-25T17:45:00.000Z"
}
```

### Error Responses

- **404 Not Found**: Returned if the arena ID does not exist.
  ```json
  {
    "error": "Arena with ID <id> not found"
  }
  ```
- **500 Internal Server Error**: Unexpected server errors.
