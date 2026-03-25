# Contract Event Reference

All events include a version marker (`v: u32`) as the first field of the
data payload. Consumers should check this field to detect schema changes
without requiring redeployment.

Current payload version: **1**

---

## Arena Contract

| Topic         | Emitting Function      | Data Fields                              |
|---------------|------------------------|------------------------------------------|
| `PAUSED`      | `pause()`              | `(v)`                                    |
| `UNPAUSED`    | `unpause()`            | `(v)`                                    |
| `UP_PROP`     | `propose_upgrade()`    | `(v, new_wasm_hash: BytesN<32>, execute_after: u64)` |
| `UP_EXEC`     | `execute_upgrade()`    | `(v, new_wasm_hash: BytesN<32>)`         |
| `UP_CANC`     | `cancel_upgrade()`     | `(v)`                                    |
| `G_END`       | *(reserved)*           | *(not currently emitted)*                |

## Factory Contract

| Topic         | Emitting Function      | Data Fields                              |
|---------------|------------------------|------------------------------------------|
| `WL_ADD`      | `add_to_whitelist()`   | `(v, host: Address)`                     |
| `WL_REM`      | `remove_from_whitelist()` | `(v, host: Address)`                  |
| `POOL_CRE`    | `create_pool()`        | `(v, pool_id: u32, creator: Address, capacity: u32, stake_amount: i128)` |
| `UP_PROP`     | `propose_upgrade()`    | `(v, new_wasm_hash: BytesN<32>, execute_after: u64)` |
| `UP_EXEC`     | `execute_upgrade()`    | `(v, new_wasm_hash: BytesN<32>)`         |
| `UP_CANC`     | `cancel_upgrade()`     | `(v)`                                    |

## Payout Contract

| Topic         | Emitting Function         | Data Fields                           |
|---------------|---------------------------|---------------------------------------|
| `PAYOUT`      | `distribute_winnings()`   | `(v, winner: Address, amount: i128, currency: Symbol)` |

---

## Versioning Policy

- The `v` field is always the **first** element of the data tuple.
- When fields are added, removed, or reordered the version is bumped.
- Consumers should fall back gracefully on unknown versions.
