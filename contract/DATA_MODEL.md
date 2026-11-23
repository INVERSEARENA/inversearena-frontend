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
| `DataKey::Submission(round_number, player)` | `Choice` | A player's Heads/Tails choice for a given round (bounded per round — see `contract/BOUNDS.md`) |
| `DataKey::Survivor(player)` | `()` | Marker set when a player successfully joins; used to verify eligibility in `claim` |
| `DataKey::Eliminated(player)` | `bool` | Marker set when a player is eliminated by `resolve_round`; used by `submit_choice` to return `PlayerEliminated` instead of `NotASurvivor` |
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
| `resolve_round` | `Round`, `HeadsSubmitters(n)`, `TailsSubmitters(n)`, `Survivor(player)` | `Round`, remove `Survivor(player)`, write `Eliminated(player)`, update `S_COUNT` (instance) | `Round`, `Eliminated(player)` |
| `get_config` | `Config` | — | — |
| `get_round` | `Round` | — | — |
| `get_choice` | `Submission(n, player)` | — | — |
| `join` | `TOKEN`, `CAPACITY`, `S_COUNT`, `PRIZE` (instance), `Survivor(player)` | `Survivor(player)`, `S_COUNT`, `PRIZE` (instance) | `Survivor(player)` |
| `set_token` ¹ | `ADMIN` (instance) | `TOKEN` (instance) | — |
| `survivor_count` | `S_COUNT` (instance) | — | — |
| `claim` | `G_FIN`, `S_COUNT`, `Survivor(winner)`, `PrizeClaimed(winner)`, `PRIZE`, `TOKEN` | `PrizeClaimed(winner)`, `PRIZE`, `G_FIN` (instance) | `PrizeClaimed(winner)` |
| `initialize` | `ADMIN` (instance) | `ADMIN` (instance) | — |
| `propose_upgrade` ¹ | `ADMIN` (instance) | `P_HASH`, `P_AFTER` (instance) | — |
| `execute_upgrade` ¹ | `ADMIN`, `P_AFTER`, `P_HASH` (instance) | removes `P_HASH`, `P_AFTER` (instance) | — |
| `cancel_upgrade` ¹ | `ADMIN`, `P_HASH` (instance) | removes `P_HASH`, `P_AFTER` (instance) | — |
| `set_capacity` | `ADMIN` (instance) | `CAPACITY` (instance) | — |
| `get_arena_state` | `S_COUNT`, `CAPACITY` (instance), `Round` | — | — |
| `get_user_state` | `Survivor(player)`, `Winner(player)` | — | — |

¹ Exempt from the global pause check — see [Emergency Pause Policy](#emergency-pause-policy) below.

## View Functions

These read-only functions expose aggregated contract state for frontend clients and indexers. They require no authorization and do not modify state.

### `get_user_state(player: Address) → Result<UserStateView, ArenaError>`

Returns a snapshot of a single player's participation status.

**Return type: `UserStateView`**

| Field | Type | Description |
| --- | --- | --- |
| `is_survivor` | `bool` | `true` if the player has a `Survivor` entry (has joined the arena) |
| `has_submitted` | `bool` | `true` if the player has submitted a choice for the current round |
| `choice` | `Choice` | The player's `Heads`/`Tails` submission (only meaningful when `has_submitted` is `true`) |
| `has_claimed` | `bool` | `true` if the player has already claimed their prize via `claim()` |

**Errors**: `ArenaError::NotInitialized` if `init` has not been called.

### `get_full_state() → Result<FullStateView, ArenaError>`

Returns a combined snapshot of the entire contract state in a single call, reducing the number of RPC round-trips needed by the frontend.

**Return type: `FullStateView`**

| Field | Type | Description |
| --- | --- | --- |
| `config` | `ArenaConfig` | Current round speed configuration (see `ArenaConfig`) |
| `round` | `RoundState` | Current round state (see `RoundState`) |
| `is_paused` | `bool` | Whether the contract is currently paused |

**Errors**: `ArenaError::NotInitialized` if `init` has not been called.

### `get_player_status(player: Address) → Result<PlayerStatus, ArenaError>` (#1582)

Returns every per-player fact a client needs to gate Join, Commit, Reveal,
Claim and Refund, in one simulation. Backend eligibility checks and the
frontend arena view treat it as the source of truth.

| Field | Type | Description |
| --- | --- | --- |
| `joined` | `bool` | The address is on the roster. `false` (not an error) for non-players and players who left the lobby |
| `active` | `bool` | Joined and not eliminated |
| `committed` | `bool` | Commitment stored for `current_round`; only `true` while a round runs |
| `revealed` | `bool` | Choice revealed for `current_round`; only `true` while a round runs |
| `eliminated_round` | `Option<u32>` | Round of elimination, `rounds_survived + 1` (only lobby joins are allowed and every resolution visits every active player) |
| `elimination_reason` | `EliminationReason` | `NotEliminated`, `Majority`, `NoReveal`, `NoCommit`, or `Unrecorded` for players eliminated before reasons were stored |
| `refund_claimed` | `bool` | Refund taken from a `Cancelled` arena |
| `winner` | `bool` | Recorded winner of a `Finished`/`Settled` arena |
| `current_round` | `u32` | Round in progress, or the last completed round when none is running |
| `phase` | `ArenaPhase` | `Lobby`, `Commit`, `Reveal`, `Intermission`, `Finished`, `Settled`, `Cancelled` |

`ArenaPhase` splits `GameState::Open` into `Lobby` (no round played) and
`Intermission`, and `GameState::Active` into `Commit` (`now < commit_deadline`)
and `Reveal`, matching the guards in `submit_commitment` and `reveal_choice`.

**Read path.** O(1) in time and space, independent of roster size: at most four
contract entries (`CONFIG`, `Player`, then `CommitmentForRound` + `ChoiceForRound`
during a round, or one of `EliminationReason` / `RefundClaimed` / `Winner`).
It uses dedicated `peek_*` accessors that never extend TTLs or run the roster
migration, so it writes nothing. `player_status_tests.rs` asserts the ledger
snapshot (entries and `live_until`) is unchanged, and measures the compiled
WASM in the commit phase at 6 read entries (including contract code and
instance), 0 writes, 0 rent bumps, about 8.9M instructions, identical for 2
and 10 players.

**Write path.** `resolve_round` stores `EliminationReason(player)` once per
eliminated player, decided while that round's commitment and choice still
exist. `NoReveal` vs `NoCommit` costs one extra read for non-revealers only.

**Archived entries.** The read never bumps rent. Since Protocol 23 (CAP-66),
archived persistent entries in an `InvokeHostFunction` footprint are restored
automatically, so an archived entry does not make the read fail inside the
contract; RPC simulation reports any restoration it needs. A key that was never
written (for example a refund flag) reads as its default.

**Errors**: `ArenaError::NotInitialized` if `initialize` has not been called.

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

**However, governance/upgrade functions and admin-only recovery configuration are explicitly exempt from the pause check.**

### Exempt functions

| Function | Pause exempt? | Reason |
| --- | --- | --- |
| `propose_upgrade` | **Yes** | Admin must be able to queue a recovery upgrade at any time |
| `execute_upgrade` | **Yes** | Admin must be able to deploy the recovery upgrade after the timelock |
| `cancel_upgrade` | **Yes** | Admin must be able to retract an incorrect proposal before correcting it |
| `set_token` | **Yes** | Admin must be able to rotate a compromised token address while gameplay is paused |
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

> `propose_upgrade`, `execute_upgrade`, `cancel_upgrade`, and `set_token` MUST
> NOT call `require_not_paused`. Any future addition of new governance or
> admin-only recovery functions should follow the same exemption rule and update
> this table.

### Protocol-wide pause (#1583)

A host's own `pause` only stops their arena. When a vault, oracle or token is
compromised, the protocol admin stops every arena at once with the factory's
`set_global_pause(paused, reason)`, which emits `GPAUSE (paused, reason)`.

**Authority.** Only the factory admin may call it, through `require_auth`.
Deploy the admin as a Stellar multisig account whose medium threshold needs
two signers: `require_auth` on a Stellar account enforces its signers at the
medium threshold, which gives the call two-person approval without extra
contract logic.

**Enforcement.** Each arena's `require_not_paused` checks its local flag first
(`ContractPaused`), then asks its factory `is_globally_paused()`
(`GloballyPaused`, code 44). That covers `join_arena`, `leave_arena`,
`submit_commitment`, `reveal_choice`, `start_round`, `resolve_round`, `claim`,
`claim_refund`, `cancel_arena`, `cancel_unstarted`, `expire_arena`,
`propose_admin` and `accept_admin`. `ban_player` (refunds) and
`force_cancel_arena` (drains the vault) also move funds, so they check the
global flag only; the host's local pause still exempts them as before. Reads,
`pause`/`unpause` and upgrade functions are never gated.

**Refunds and claims while paused.** `claim`, `claim_refund` and every
cancellation path are blocked, so no funds move. Nothing is forfeited: a pause
changes no game state, and deadlines that pass meanwhile only make
`expire_arena` / `cancel_unstarted` available after the unpause, which leads to
refunds. `global_pause_tests.rs` verifies that a refund blocked during the
pause is paid exactly once afterwards.

**Unpause ordering.** The two flags are independent and gameplay needs both
clear. A host unpause never lifts the global pause, and a global unpause never
lifts a host pause. With both set, `ContractPaused` is reported.

**Factory unavailable or upgraded: fail open.** If the factory cannot answer
(not a contract, or a version older than `is_globally_paused`), the check
passes. Such a factory cannot set the pause, so there is nothing to enforce,
whereas failing closed would freeze every arena, refunds included, on a
deployment-ordering mistake. A factory upgrade keeps instance storage, so a set
pause survives it. Budget exhaustion aborts the whole transaction, so callers
cannot force the open path. Upgrade the factory before arenas.

**Cost.** The flag lives in factory instance storage, which invoking the
factory loads anyway, so a check adds exactly two read-only entries (factory
instance and code), no writes and no rent bumps. Measured against the compiled
factory WASM: 5.69M instructions and 48,856 read bytes per check, most of it VM
instantiation, which Protocol 23's module cache amortises on-chain. A full
`join_arena` with both contracts as WASM measures 17.1M instructions.

## Historical baseline note

Prior to the implementation of game state storage and TTL management, the accurate
storage model for this workspace was:

> No custom Soroban storage keys are currently defined or used.
