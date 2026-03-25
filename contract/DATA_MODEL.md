# Soroban Contract Data Model

This document describes the current on-chain data model for the Soroban workspace in `contract/`.

It is intended to make storage behavior explicit for:
- contract debugging
- off-chain indexer development
- future schema migrations
- contributor onboarding

## Scope

Contracts in this workspace:
- `arena`
- `factory`
- `payout`
- `staking`

## Workspace Summary

| Contract | Uses storage? | Storage key schema | TTL policy |
| --- | --- | --- | --- |
| `arena` | Yes | `DataKey` enum (persistent) + symbol keys (instance) | Explicit bump on every write |
| `factory` | Yes | Symbol keys (instance) | Instance-managed |
| `payout` | No | None | None |
| `staking` | No | None | None |

## Storage Key Inventory

### Arena Contract

File: `contract/arena/src/lib.rs`

#### Persistent storage (`env.storage().persistent()`)

| `DataKey` variant | Value type | Description |
| --- | --- | --- |
| `DataKey::Config` | `ArenaConfig` | Round speed configuration; written once on `init` |
| `DataKey::Round` | `RoundState` | Active round state (number, ledgers, submission count, flags) |
| `DataKey::Submission(round_number, player)` | `Choice` | A player's Heads/Tails choice for a given round |
| `DataKey::Survivor(player)` | `()` | Marker set when a player successfully joins; used to verify eligibility in `claim` |
| `DataKey::PrizeClaimed(winner)` | `i128` | Records the prize amount claimed by the winner; prevents double-claim |

#### Instance storage (`env.storage().instance()`)

| Symbol key | Value type | Description |
| --- | --- | --- |
| `ADMIN` | `Address` | Contract admin; set once via `initialize` |
| `P_HASH` | `BytesN<32>` | WASM hash pending upgrade via 48-hour timelock |
| `P_AFTER` | `u64` | Earliest timestamp at which `execute_upgrade` may be called |
| `TOKEN` | `Address` | SAC token contract used for stake deposits and prize payouts; set via `set_token` |
| `S_COUNT` | `u32` | Running count of survivors registered via `join`; incremented on each successful join |
| `PRIZE` | `i128` | Accumulated prize pool; incremented by each player's stake on `join`, zeroed on `claim` |
| `G_FIN` | `bool` | Permanently `true` after a successful `claim`; blocks any further claim attempts |

### Factory Contract

File: `contract/factory/src/lib.rs`

Instance storage only:

| Symbol key | Value type | Description |
| --- | --- | --- |
| `ADMIN` | `Address` | Contract admin |
| `P_HASH` | `BytesN<32>` | WASM hash pending upgrade |
| `P_AFTER` | `u64` | Upgrade timelock timestamp |

### Payout and Staking Contracts

No custom Soroban storage keys are currently defined or used.

## Access Pattern Matrix

### Arena contract

| Function | Keys read | Keys written | TTL bumped |
| --- | --- | --- | --- |
| `init` | — | `Config`, `Round` | `Config`, `Round` |
| `start_round` | `Config`, `Round` | `Round` | `Round` |
| `submit_choice` | `Round`, `Submission(n, player)` | `Submission(n, player)`, `Round` | `Submission(n, player)`, `Round` |
| `timeout_round` | `Round` | `Round` | `Round` |
| `get_config` | `Config` | — | — |
| `get_round` | `Round` | — | — |
| `get_choice` | `Submission(n, player)` | — | — |
| `join` | `TOKEN`, `S_COUNT`, `PRIZE` (instance), `Survivor(player)` | `Survivor(player)`, `S_COUNT`, `PRIZE` (instance) | `Survivor(player)` |
| `set_token` | `ADMIN` (instance) | `TOKEN` (instance) | — |
| `survivor_count` | `S_COUNT` (instance) | — | — |
| `claim` | `G_FIN`, `S_COUNT`, `Survivor(winner)`, `PrizeClaimed(winner)`, `PRIZE`, `TOKEN` | `PrizeClaimed(winner)`, `PRIZE`, `G_FIN` (instance) | `PrizeClaimed(winner)` |
| `initialize` | `ADMIN` (instance) | `ADMIN` (instance) | — |
| `propose_upgrade` ¹ | `ADMIN` (instance) | `P_HASH`, `P_AFTER` (instance) | — |
| `execute_upgrade` ¹ | `ADMIN`, `P_AFTER`, `P_HASH` (instance) | removes `P_HASH`, `P_AFTER` (instance) | — |
| `cancel_upgrade` ¹ | `ADMIN`, `P_HASH` (instance) | removes `P_HASH`, `P_AFTER` (instance) | — |
| `join` | `Survivor(player)`, `S_COUNT` (instance) | `Survivor(player)`, `S_COUNT` (instance) | `Survivor(player)` |
| `set_capacity` | `ADMIN` (instance) | `CAPACITY` (instance) | — |
| `get_arena_state` | `S_COUNT`, `CAPACITY` (instance), `Round` | — | — |

¹ Exempt from the global pause check — see [Emergency Pause Policy](#emergency-pause-policy) below.

## TTL Policy Baseline

All **persistent** storage entries in the arena contract are explicitly extended on
every write. The policy constants are defined in `contract/arena/src/lib.rs`:

| Constant | Value (ledgers) | Approximate wall-clock duration |
| --- | --- | --- |
| `GAME_TTL_THRESHOLD` | 100,000 | ~5.8 days (at 5 s/ledger) |
| `GAME_TTL_EXTEND_TO` | 535,680 | ~31 days (at 5 s/ledger) |

**Rule**: A `bump(env, key)` helper calls `storage().persistent().extend_ttl(key,
GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO)` immediately after every
`storage().persistent().set()`. This ensures the TTL is extended to at least
`GAME_TTL_EXTEND_TO` ledgers from the current ledger whenever it would fall below
`GAME_TTL_THRESHOLD`, covering the maximum possible game duration.

**Instance storage** (admin key, upgrade proposal keys) relies on the automatic
instance TTL managed by the Soroban host and is not explicitly bumped by game logic.

**Factory/payout/staking** contracts do not use persistent storage for game state.

## ER-Style State Diagram

```
ArenaConfig (1)
    │ round_speed_in_ledgers
    │
    └──────────────────────────────────────────────────┐
                                                       │ governs deadline
RoundState (1)                                         │
    │ round_number                                     │
    │ round_start_ledger ──────────────────────────────┘
    │ round_deadline_ledger
    │ active
    │ timed_out
    │ total_submissions
    │
    └─── has many ───► Submission(round_number, player_address)
                           │ Choice { Heads | Tails }
```

Round lifecycle state machine:

```
[not initialised]
    │ init()
    ▼
[Config set, Round { active: false }]
    │ start_round()
    ▼
[Round { active: true }]
    │ submit_choice()  (multiple callers, within deadline)
    │ timeout_round()  (any caller, after deadline)
    ▼
[Round { active: false, timed_out: true }]
    │ start_round()
    ▼
[Round { active: true, round_number + 1 }] ...
```

## Emergency Pause Policy

### Overview

The arena contract exposes a global pause mechanism (`pause` / `unpause`, admin-only).
When paused, all state-mutating game functions reject calls with `ArenaError::Paused`.

**However, governance/upgrade functions are explicitly exempt from the pause check.**

### Exempt functions

| Function | Pause exempt? | Reason |
| --- | --- | --- |
| `propose_upgrade` | **Yes** | Admin must be able to queue a recovery upgrade at any time |
| `execute_upgrade` | **Yes** | Admin must be able to deploy the recovery upgrade after the timelock |
| `cancel_upgrade` | **Yes** | Admin must be able to retract an incorrect proposal before correcting it |
| `pause` | **Yes** | Admin must always be able to pause |
| `unpause` | **Yes** | Admin must always be able to unpause |

### Non-exempt functions (blocked when paused)

| Function | Blocked when paused? |
| --- | --- |
| `start_round` | Yes |
| `submit_choice` | Yes |
| `timeout_round` | Yes |
| `join` | Yes |
| `claim` | Yes |

### Rationale

A global pause is an emergency safety measure (e.g. to halt activity during a
critical bug discovery). If the pause also blocked upgrade functions, a paused
contract could become permanently locked with no recovery path. By keeping
governance functions exempt, the admin retains full ability to:

1. Propose a corrective WASM upgrade while the contract is paused.
2. Wait for the 48-hour timelock to elapse.
3. Execute the upgrade and restore normal operation.
4. Unpause.

### Invariant

> `propose_upgrade`, `execute_upgrade`, and `cancel_upgrade` MUST NOT call
> `require_not_paused`. Any future addition of new governance functions should
> follow the same exemption rule and update this table.

## Historical baseline note

Prior to the implementation of game state storage and TTL management, the accurate
storage model for this workspace was:

> No custom Soroban storage keys are currently defined or used.
