# Contract Event Reference

Arena and factory events include a version marker (`v: u32`) in the
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
| `R_START`     | `start_round()`        | `(round_number: u32, round_start_ledger: u32, round_deadline_ledger: u32, v)` |
| `R_TOUT`      | `timeout_round()`      | `(round_number: u32, total_submissions: u32, v)` |
| `RSLVD`       | `resolve_round()`      | `(round_number: u32, heads_count: u32, tails_count: u32, outcome: Symbol, eliminated_count: u32, survivor_count: u32, v)` |
| `started`     | `start_round()` (#1552) | `(round: u32, commit_deadline: u64, reveal_deadline: u64)` — commits close at `commit_deadline`; the round is only resolvable at/after `reveal_deadline` |
| `claimed`     | `claim()` (#1554)      | `(winner: Address, gross: i128, fee: i128, net: i128, yield_amount: i128, treasury: Address)` — `gross` is the vault withdrawal, `fee` the platform cut routed to `treasury`, `net` the winner's payout, `yield_amount` the fee base (yield only) |
| `fee_coll`    | `claim()` (#1554)      | `(treasury: Address, fee: i128, fee_bps: u32)` — emitted only when the fee is nonzero |
| `WIN_SET`     | `set_winner()`         | `(player: Address, stake: i128, yield_comp: i128, v)` |
| `CLAIM`       | `claim()`              | `(winner: Address, prize: i128, v)`      |
| `frsh_pol`    | `set_oracle_freshness_policy()` (#1512) | `(admin: Address, max_age_secs: u64, warn_age_secs: u64)` |
| `oracle_freshness_observed` | `resolve_round()` (#1512) | `(round: u32, classification_code: u32, age_secs: u64)` — emitted on every attempt, success or rejection; `classification_code`: 0=Fresh, 1=Warning, 2=Stale, 3=Unavailable |
| `oracle_stale_rejected` | `resolve_round()` (#1512) | `(round: u32, age_secs: u64)` — emitted only when resolution is refused for staleness |

> Note (#1512): several rows in this table (e.g. `fee_upd`, `vault_oracle_failed`)
> predate this table and were never added to it — pre-existing drift, not
> introduced here. `contract/arena/src/events.rs` is the source of truth.

## Factory Contract

| Topic         | Emitting Function      | Data Fields                              |
|---------------|------------------------|------------------------------------------|
| `WL_ADD`      | `add_to_whitelist()`   | `(v, host: Address)`                     |
| `WL_REM`      | `remove_from_whitelist()` | `(v, host: Address)`                  |
| `POOL_CRE`    | `create_pool()`        | `(v, pool_id: u32, creator: Address, capacity: u32, stake_amount: i128)` |
| `TRS_PROP`    | `propose_treasury()` (#1554) | `(new_treasury: Address)` — two-step proposal; no effect until accepted |
| `TRS_CHG`     | `accept_treasury()` (#1554) | `(treasury: Address)` — emitted when the pending treasury becomes active |
| `UP_PROP`     | `propose_upgrade()`    | `(v, new_wasm_hash: BytesN<32>, execute_after: u64)` |
| `UP_EXEC`     | `execute_upgrade()`    | `(v, new_wasm_hash: BytesN<32>)`         |
| `UP_CANC`     | `cancel_upgrade()`     | `(v)`                                    |

## Staking Contract

Topics use only the fixed symbol. All variable data (staker address, token
address, amounts) is in the data payload so indexers can filter on `STAKED` /
`UNSTAKED` alone without knowing the token address in advance.

| Topic      | Emitting Function | Data Fields                                              |
|------------|-------------------|----------------------------------------------------------|
| `STAKED`   | `stake()`         | `(staker: Address, token_contract: Address, amount: i128, minted_shares: i128)` |
| `UNSTAKED` | `unstake()`       | `(staker: Address, token_contract: Address, amount: i128, shares: i128)` |

> **Note:** Staking events intentionally omit the `v` version field for now
> because the staking contract does not define `EVENT_VERSION`. Add `v` as the
> last field and bump the schema version in a coordinated release if the payload
> schema changes.

## Payout Contract

| Topic         | Emitting Function         | Data Fields                           |
|---------------|---------------------------|---------------------------------------|
| `PAYOUT`      | `distribute_winnings()`   | `(v, winner: Address, amount: i128, currency: Symbol)` |

---

## Versioning Policy

- The `v` field is included in every arena/factory event payload.
- When fields are added, removed, or reordered the version is bumped.
- Consumers should fall back gracefully on unknown versions.
