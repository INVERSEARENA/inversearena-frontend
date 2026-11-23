# Keyset Pagination Architecture & Compatibility Design

## 1. Overview and Problem Statement

Previous implementations of `/api/arenas`, `/api/pools/:id/eliminations`, and `RoundRepository.listByArenaId` encoded offset values inside pagination cursors (or directly exposed `skip: offset`). In a dynamic blockchain environment where arena statuses update and players/rounds are inserted concurrently, offset pagination suffers from page skipping and record duplication.

## 2. Keyset Pagination Specification

All paginated listings are migrated to versioned compound keyset pagination with deterministic tie-breakers:

| Listing | Primary Sort Key | Tie Breaker | Direction | Matching Index |
| --- | --- | --- | --- | --- |
| Arenas | `createdAt` | `id` | DESC | `(createdAt DESC, id DESC)` |
| Rounds | `roundNumber` | `id` | ASC | `(arenaId, roundNumber ASC, id ASC)` |
| Eliminations | `eliminatedAt` | `id` | DESC | `(roundId, eliminatedAt DESC, id DESC)` |

### Cursor Payload (Version 1)
```json
{
  "v": 1,
  "sort": {
    "key": "2026-10-16T12:00:00.000Z"
  },
  "id": "c1234567..."
}
```
Payloads are serialized to `base64url` and validated with Zod:
- Maximum encoded length: 512 bytes
- Type-checked keys (ISO-8601 strings, integers, or UUIDs)
- No user-injected sort columns or filter overrides

## 3. Backward Compatibility & Migration Window

To avoid breaking existing frontend clients and automated callers:
1. **Legacy Cursors**: If a cursor parses as a JSON offset object (`{"offset": 25}`) or a numeric string (`"25"`), the repository decodes it in legacy compatibility mode, executes an offset fallback query, and returns a modern `v1` keyset cursor in the response.
2. **Malformed or Tampered Cursors**: Invalid or expired cursor payloads fail with a typed 400 `INVALID_CURSOR` response instructing the client to restart traversal from the beginning.
