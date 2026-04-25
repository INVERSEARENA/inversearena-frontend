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
| `WIN_SET`     | `set_winner()`         | `(player: Address, stake: i128, yield_comp: i128, v)` |
| `CLAIM`       | `claim()`              | `(winner: Address, prize: i128, v)`      |

## Factory Contract

| Topic         | Emitting Function      | Data Fields                              |
|---------------|------------------------|------------------------------------------|
| `WL_ADD`      | `add_to_whitelist()`   | `(v, host: Address)`                     |
| `WL_REM`      | `remove_from_whitelist()` | `(v, host: Address)`                  |
| `POOL_CRE`    | `create_pool()`        | `(v, pool_id: u32, creator: Address, capacity: u32, stake_amount: i128)` |
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
| `TOK_SET`     | `set_currency_token()`    | `(v, currency: Symbol, token_address: Address)` |

---

## Pause-Exempt Operations (Policy)

Emergency pause intentionally does not block recovery/governance controls. The following families are pause-exempt across contracts:

- Upgrade governance: `propose_upgrade`, `execute_upgrade`, `cancel_upgrade`
- Two-step admin transfer: `propose_admin`, `accept_admin`, `cancel_admin_transfer`
- Incident-response token rotation in payout: `set_currency_token`

These exemptions are covered by contract tests in each module.

---

## Versioning Policy

- The `v` field is included in every arena/factory event payload.
- When fields are added, removed, or reordered the version is bumped.
- Consumers should fall back gracefully on unknown versions.
