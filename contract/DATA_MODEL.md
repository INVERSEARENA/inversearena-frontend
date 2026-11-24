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
- `rwa-adapter`
- `fee-router`
- `staking`

## Workspace Summary

| Contract | Storage domains | TTL policy |
| --- | --- | --- |
| `arena` | `DataKey` persistent keys, symbol persistent keys, round temporary keys | Persistent keys extend on every read/write through `ArenaStorage`; commit/choice temporary TTLs are round-scoped |
| `factory` | `DataKey` persistent keys plus `GlobalPaused` instance flag | Persistent keys extend on every read/write through `FactoryStorage`; instance TTL extends on lifecycle reads |
| `payout` | `DataKey` persistent keys plus `Outflow` temporary keys | Persistent keys extend on every read/write; outflows use a two-day temporary TTL |
| `rwa-adapter` | `DataKey` and symbol persistent keys plus `ShareSupply` / `FACTORY` instance keys | All keys extend on read/write, including `withdraw_all` positions, basis and shares |
| `fee-router` | `DataKey` persistent keys | All keys extend on read/write through `RouterStorage` |
| `staking` | Symbol and `DataKey` persistent keys | All keys extend on read/write; `renew_storage` and `storage_inventory` expose bounded keeper support |

## Storage Key and TTL Matrix

This is the authoritative inventory for issue #1828. `threshold` and
`extend-to` are ledgers at a 5-second ledger cadence. A key is extended when a
supported read or write sees it below `threshold`; the new TTL becomes at least
`extend-to` ledgers. "Read/write" in the bump column means the repository layer
extends before reading and after writing, so both claim/refund-style reads and
mutations restore headroom.

Persistent baseline (`arena`, `factory`, `fee-router`, `rwa-adapter`, `staking`,
and payout configuration):

| Constant | Value | Approximate duration |
| --- | ---: | --- |
| `PERSISTENT_TTL_THRESHOLD` | 518,400 | ~30 days |
| `PERSISTENT_TTL_EXTEND_TO` / `PERSISTENT_TTL_TARGET` | 6,307,200 | ~1 year |

Payout outflow/config exceptions:

| Constant | Value | Applies to |
| --- | ---: | --- |
| `PERSISTENT_TTL_THRESHOLD` | 518,400 | Payout admin, factory, caps, idempotency records, `StorageVersion` |
| `PERSISTENT_TTL_TARGET` | 6,307,200 | Payout admin, factory, caps, idempotency records, `StorageVersion` |
| `PAYOUT_TTL_THRESHOLD` | 3,153,600 | Legacy `Paid`, `Payout`, `DailyCap`, `PendingCap` helper paths |
| `PAYOUT_TTL_EXTEND_TO` | 6,307,200 | Legacy payout helper paths |
| `OUTFLOW_TTL_LEDGERS` | 34,560 | `Outflow(day)` temporary key (~2 days) |

### Arena

Source: `contract/arena/src/storage.rs`, `contract/arena/src/lib.rs`.

| Contract | Key or variant | Storage domain | Threshold | Extend-to | Bump trigger | Notes |
| --- | --- | --- | ---: | ---: | --- | --- |
| arena | `DataKey::Player(Address)` | persistent | 518,400 | 6,307,200 | read/write via `ArenaStorage`/`get_player` | Contains `PlayerState`, stake and payout eligibility |
| arena | `DataKey::BannedPlayer(Address)` | persistent | 518,400 | 6,307,200 | read/write | Ban list must survive settlement |
| arena | `DataKey::Sponsor(Address)` | persistent | 518,400 | 6,307,200 | read/write | Refund destination for sponsored seats |
| arena | `DataKey::EliminationReason(Address)` | persistent | — | — | none | Written by `resolve_round`, read by `get_player_status`; informational only, written without a rent bump |
| arena | `DataKey::RefundClaimed(Address)` | persistent | 518,400 | 6,307,200 | read/write in `claim_refund` | Prevents double refunds |
| arena | `DataKey::Winner` | persistent | 518,400 | 6,307,200 | read/write in `claim` | Prize recipient |
| arena | `DataKey::PrizeClaimed` | persistent | 518,400 | 6,307,200 | read/write in `claim` | Prevents double payout |
| arena | `DataKey::FundsInVault` | persistent | 518,400 | 6,307,200 | read/write | Marks unresolved vault principal after settlement |
| arena | `DataKey::Leaderboard`, `DataKey::LeaderboardLimit`, `DataKey::ResolutionLeaderboard` | persistent | 518,400 | 6,307,200 | read/write | Aggregates and paged-resolution accumulator |
| arena | `DataKey::Resolution`, `DataKey::ResolutionPlayers` | persistent | 518,400 | 6,307,200 | read/write | Paged-resolution cursor and working roster |
| arena | `DataKey::PlayerPage(u32)`, `DataKey::SurvivorPage(u32)`, `DataKey::RosterCount`, `DataKey::SurvivorCount` | persistent | 518,400 | 6,307,200 | read/write | Paged roster cache and counters |
| arena | `DataKey::RoundStart`, `DataKey::RoundDuration`, `DataKey::LastTransitionAt`, `DataKey::InterRoundTimeout`, `DataKey::PausedDeadlineSeconds`, `DataKey::PausedAt` | persistent | 518,400 | 6,307,200 | read/write | Deadline and pause accounting |
| arena | `DataKey::OptionCount`, `DataKey::MinPlayers`, `DataKey::MaxPlayers`, `DataKey::PlatformFeeBps`, `DataKey::OracleFreshnessPolicy`, `DataKey::StartDeadline` | persistent | 518,400 | 6,307,200 | read/write | Configuration read by all fund-moving paths |
| arena | `DataKey::YieldSnapshot(u32)`, `DataKey::RoundResult(u32)`, `DataKey::RoundYieldBps(u32)`, `DataKey::LastVaultBalance` | persistent | 518,400 | 6,307,200 | read/write | Settlement yield accounting |
| arena | `DataKey::StorageVersion` | persistent | 518,400 | 6,307,200 | read/write | Current version 2 |
| arena | symbol keys `CONFIG`, `PADMIN`, `UPGRADE` | persistent | 518,400 | 6,307,200 | read/write | Config, pending admin, upgrade timelock |
| arena | `DataKey::CommitmentForRound(Address, u32)` | temporary | round duration + 17,280, capped at 3,110,400 | n/a | set at commit | Deliberately round-scoped; not a fund-bearing record |
| arena | `DataKey::ChoiceForRound(Address, u32)` | temporary | round duration + 17,280, capped at 3,110,400 | n/a | set at reveal | Deliberately round-scoped; not a fund-bearing record |
| arena | `DataKey::ReentrancyGuard` | temporary | call-scoped | n/a | set during guarded call | Transient lock |

### Factory

Source: `contract/factory/src/storage.rs`, `contract/factory/src/lib.rs`.

| Contract | Key or variant | Storage domain | Threshold | Extend-to | Bump trigger | Notes |
| --- | --- | --- | ---: | ---: | --- | --- |
| factory | `DataKey::Admin`, `DataKey::PendingAdmin` | persistent | 518,400 | 6,307,200 | read/write | Admin and two-step transfer |
| factory | `DataKey::CreatorStake(Address)`, `DataKey::MinStake`, `DataKey::ArenaWasmHash` | persistent | 518,400 | 6,307,200 | read/write | Deployment and stake records |
| factory | `DataKey::Whitelisted(Address)`, `DataKey::ApprovedVault(Address)`, `DataKey::ApprovedOracle(Address)`, `DataKey::SupportedToken(Address)` | persistent | 518,400 | 6,307,200 | read/write | Approval flags |
| factory | `DataKey::ApprovedVaultToken(Address)`, `DataKey::VaultLifecycle(Address)`, `DataKey::OracleLifecycle(Address)`, `DataKey::TokenLifecycle(Address)`, `DataKey::RegistryRevision` | persistent | 518,400 | 6,307,200 | read/write | #1688 lifecycle registry |
| factory | `DataKey::Pool(u32)`, `DataKey::PoolSequence`, `DataKey::PoolCount`, `DataKey::ActivePoolCount(Address)`, `DataKey::HostPoolCount(Address)`, `DataKey::HostPoolPage(Address, u32)`, `DataKey::StatusBucket(ArenaStatus)` | persistent | 518,400 | 6,307,200 | read/write | Pool registry and pages |
| factory | `DataKey::PoolIntegration(u32)`, `DataKey::LiveUse(RegistryKind, Address)` | persistent | 518,400 | 6,307,200 | read/write | Live liabilities by integration |
| factory | `DataKey::MaxActivePools`, `DataKey::Paused`, `DataKey::SupportedTokens`, `DataKey::StorageVersion` | persistent | 518,400 | 6,307,200 | read/write | Bounds, pause and migration state |
| factory | `DataKey::GlobalPaused` | instance | 518,400 | 6,307,200 | read on every `is_globally_paused`/lifecycle check | Protocol-wide emergency pause (#1583) |

### Payout

Source: `contract/payout/src/storage.rs`, `contract/payout/src/lib.rs`.

| Contract | Key or variant | Storage domain | Threshold | Extend-to | Bump trigger | Notes |
| --- | --- | --- | ---: | ---: | --- | --- |
| payout | `DataKey::Admin` | persistent | 518,400 | 6,307,200 | read/write in `distribute_*` and admin paths | Payout authority |
| payout | `DataKey::PendingAdmin` | persistent | 518,400 | 6,307,200 | read/write | Two-step admin transfer |
| payout | `DataKey::Token`, `DataKey::Factory`, `DataKey::DailyCap`, `DataKey::PendingCap` | persistent | 518,400 | 6,307,200 | read/write in `distribute_winnings`, `distribute_batch`, cap paths | Fund-moving configuration |
| payout | `DataKey::Payout(BytesN<32>)` | persistent | 518,400 | 6,307,200 | read/write in `distribute_*` | Per-payout idempotency and amount |
| payout | `DataKey::Paid(u64)` | persistent | 518,400 | 6,307,200 | read/write | Legacy idempotency record; never reused |
| payout | `DataKey::StorageVersion` | persistent | 518,400 | 6,307,200 | read/write | Migration marker |
| payout | `DataKey::Outflow(u64)` | temporary | 34,560 | n/a | read/write per UTC day | Two-day daily cap counter |

### RWA adapter

Source: `contract/rwa-adapter/src/storage.rs`, `contract/rwa-adapter/src/lib.rs`.

| Contract | Key or variant | Storage domain | Threshold | Extend-to | Bump trigger | Notes |
| --- | --- | --- | ---: | ---: | --- | --- |
| rwa-adapter | `DataKey::Position(Address)` | persistent | 518,400 | 6,307,200 | read/write, including `withdraw_all` | Principal and accrued yield record |
| rwa-adapter | `DataKey::Basis(Address)`, `DataKey::Shares(Address)` | persistent | 518,400 | 6,307,200 | read/write, including `withdraw_all` | Withdraw must see live basis and shares |
| rwa-adapter | `DataKey::YieldIndex`, `DataKey::Strategies`, `DataKey::StorageVersion` | persistent | 518,400 | 6,307,200 | read/write | Yield accounting and migration state |
| rwa-adapter | `DataKey::_YieldReserve`, `DataKey::_PrincipalTotal` | persistent | 518,400 | 6,307,200 | read/write | Reserved and legacy totals |
| rwa-adapter | symbol keys `RWAINIT`, `RWACONFIG`, `PADMIN` | persistent | 518,400 | 6,307,200 | read/write | Initialization, config, pending admin |
| rwa-adapter | `ShareSupply`, `FACTORY` | instance | 518,400 | 6,307,200 | read/write | Instance total shares and factory binding |

### Fee router

Source: `contract/fee-router/src/storage.rs`.

| Contract | Key or variant | Storage domain | Threshold | Extend-to | Bump trigger | Notes |
| --- | --- | --- | ---: | ---: | --- | --- |
| fee-router | `DataKey::Admin`, `DataKey::PendingAdmin`, `DataKey::StakingContract`, `DataKey::Treasury` | persistent | 518,400 | 6,307,200 | read/write via `RouterStorage` | Admin and routing configuration |
| fee-router | `DataKey::StakingShareBps`, `DataKey::PendingShareChange`, `DataKey::Balance(Address)` | persistent | 518,400 | 6,307,200 | read/write via `RouterStorage` | Split config and accumulated fees |

### Staking

Source: `contract/staking/src/lib.rs`.

| Contract | Key or variant | Storage domain | Threshold | Extend-to | Bump trigger | Notes |
| --- | --- | --- | ---: | ---: | --- | --- |
| staking | symbols `ADMIN`, `P_ADMIN`, `PAUSED`, `TOKEN` | persistent | 518,400 | 6,307,200 | read/write | Migrated from instance storage (#1009) |
| staking | symbols `TSTAKE`, `TSHARES`, `TOTALS` | persistent | 518,400 | 6,307,200 | read/write in stake/unstake/distribute | Pool accounting |
| staking | symbols `RWRATE`, `RWFINISH`, `RWUPDATE`, `RWDUR` | persistent | 518,400 | 6,307,200 | read/write in reward paths | Reward schedule |
| staking | `DataKey::Position(Address)` | persistent | 518,400 | 6,307,200 | read/write in stake/unstake | Per-staker principal and rewards |
| staking | `DataKey::StorageVersion` | persistent | 518,400 | 6,307,200 | read/write | Migration marker |
| staking | `storage_inventory` output | n/a | n/a | n/a | read-only operator call | Inventory deliberately excludes per-user `Position` keys to keep the keeper bounded |

## Historical Access Pattern Matrix

The table below documents the pre-v2 arena key layout and is retained for
interpreting legacy ledger entries. The authoritative current key set, storage
domain and TTL behavior are in [Storage Key and TTL Matrix](#storage-key-and-ttl-matrix).

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

The current policy is uniform for fund-bearing persistent entries: extend when
the remaining TTL is below 518,400 ledgers, to at least 6,307,200 ledgers. The
constants live in each contract's storage module (`contract/arena/src/storage.rs`,
`contract/factory/src/storage.rs`, `contract/payout/src/storage.rs`,
`contract/rwa-adapter/src/storage.rs`, `contract/fee-router/src/storage.rs`) or
at the top of `contract/staking/src/lib.rs`.

**Rule**: repository `get`/`has` helpers extend before reading and `set` helpers
extend after writing. This matters for one-sided fund paths: a `claim`,
`claim_refund`, payout read, or `withdraw_all` that only reads a record still
refreshes that record. Post-write extension is required because `extend_ttl`
cannot shorten a TTL, and a freshly written entry may already have a longer TTL
than the target. Non-fund-bearing informational entries are excluded: arena
`DataKey::EliminationReason(Address)` is written without a rent bump, and the
dedicated `peek_*` read paths (including `get_player_status`) intentionally write
nothing.

**Temporary storage** is intentionally different. Arena commitment and revealed
choice entries live only as long as the round plus a 17,280-ledger grace period,
capped at Soroban's 3,110,400-ledger temporary maximum. Payout `Outflow(day)`
entries live for 34,560 ledgers. These values are not inventory gaps.

**Instance storage** is explicitly extended where it carries fund-moving state:
the factory `GlobalPaused` flag and the RWA adapter's `ShareSupply` / `FACTORY`
keys. Other instance entries still benefit from the host's automatic instance
TTL whenever any instance key is accessed.

Regression tests use `env.ledger().with_mut` to advance beyond the threshold:
`persistent_state_ttl_is_restored_on_read_and_write` in `contract/arena/src/lib.rs`,
`persistent_admin_ttl_is_restored_on_read` in factory, payout and fee-router
tests, `persistent_config_ttl_is_restored_on_read` in rwa-adapter, and
`persistent_keys_are_extended_on_read_and_write` in staking. They assert the
fund-bearing entries are still live/restorable after the advance.

Operators restore already-expired entries with
[`contract/scripts/restore-archived.sh`](scripts/restore-archived.sh)
as described in [`docs/ttl-keeper-runbook.md`](../docs/ttl-keeper-runbook.md).
TTL extension cannot recover an archived entry; only restoration can.


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
