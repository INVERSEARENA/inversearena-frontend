# factory contract API

Source: `contract/factory/src`

## `contract/factory/src/events.rs`

### pub fn `initialized` — line 26

Emitted when the factory is initialized.

```text
topic[0] = "factory"
topic[1] = "init"
data     = { v: 1, admin: Address, min_stake: i128 }
```

### pub fn `pool_created` — line 41

Emitted when a new pool / arena is created.

```text
topic[0] = "factory"
topic[1] = "pool_cre"
topic[2] = host address  (indexed)
data     = { v: 1, pool_id: u32, arena: Address, entry_fee: i128 }
```

### pub fn `pool_status_updated` — line 59

Emitted when an arena's status is updated.

```text
topic[0] = "factory"
topic[1] = "pool_st"
topic[2] = arena address  (indexed)
data     = { v: 1, pool_id: u32, new_status: u32 }
```

`new_status` is the ordinal of `ArenaStatus` (`0=Pending`, `1=Active`,
`2=Finished`, `3=Cancelled`).

### pub fn `stake_reclaimed` — line 74

Emitted when a creator's stake is reclaimed.

```text
topic[0] = "factory"
topic[1] = "stk_rclm"
topic[2] = creator address  (indexed)
data     = { v: 1, arena: Address, amount: i128 }
```

### pub fn `whitelist_added` — line 89

Emitted when a host is added to the whitelist.

```text
topic[0] = "factory"
topic[1] = "wl_add"
topic[2] = host address  (indexed)
data     = { v: 1 }
```

### pub fn `whitelist_removed` — line 104

Emitted when a host is removed from the whitelist.

```text
topic[0] = "factory"
topic[1] = "wl_rem"
topic[2] = host address  (indexed)
data     = { v: 1 }
```

### pub fn `vault_added` — line 112

Emitted when an approved vault is added.

### pub fn `vault_removed` — line 120

Emitted when an approved vault is removed.

### pub fn `oracle_added` — line 128

Emitted when an approved oracle is added.

### pub fn `oracle_removed` — line 136

Emitted when an approved oracle is removed.

### pub fn `upgraded` — line 150

Emitted when the factory WASM is upgraded.

```text
topic[0] = "factory"
topic[1] = "upgrade"
data     = { v: 1, new_wasm_hash: BytesN<32> }
```

### pub fn `pause_toggled` — line 158

Emitted when the factory is paused or unpaused.

### pub fn `admin_changed` — line 166

Emitted when the admin changes.

## `contract/factory/src/lib.rs`

### pub trait `ArenaInterface` — line 51

Local stub for the one arena entry point factory calls in production
(`initialize`, right after deploying a new arena instance). Deliberately
not `use arena::ArenaContractClient` — depending on the full `arena`
crate here would statically link its `#[contractimpl]` block into
factory's own wasm binary, and both contracts export an `unpause`
symbol, which collides at link time. `arena` stays a dev-dependency for
integration tests, which need the real contract.

### fn `set_start_deadline` — line 67

Set right after `initialize`; see arena's `set_start_deadline` (#1579).

### pub trait `VaultInterface` — line 74

Local stub for the RWA adapter's `config()` read (#1634). Local for the
same link-time reason as `ArenaClient` above.

### pub fn `version` — line 128

Return the factory contract ABI/storage version.

### pub fn `upgrade` — line 137

Upgrade the factory contract's code to `new_wasm_hash`.

Admin-gated. Upgrading in place preserves all existing state — admin,
whitelist, pool sequence, and creator stakes — so bug fixes and new
features can ship without redeploying and losing that state.

### pub fn `add_approved_vault` — line 181

Approve `vault` for new pools, registering it together with its
stake token (#1634).

Reads the vault's `config()` and stores the token, so a later
`create_pool` can detect a vault whose asset has since changed (for
example through an upgrade). Calling it again for an approved vault
re-reads and re-registers the token; that is also how a vault
approved before #1634 is migrated.

#### Errors
- `FactoryError::InvalidVault` if `vault` does not answer `config()`
  (not a contract, not an RWA adapter, or not initialised).

### pub fn `remove_approved_vault` — line 206

Emergency removal of an approved vault (#1688).

This is the pre-existing escape hatch and stays unconditional: it is
the procedure that covers liabilities the guarded `disable_approved_vault`
path would refuse. The entry is marked `Disabled` so clients stop
offering it for new arenas.

### pub fn `get_approved_vault_token` — line 224

The stake token `vault` was approved with (#1634), or `None` if it is
not approved. Lets clients offer only vault/token pairs that
`create_pool` will accept.

### pub fn `remove_approved_oracle` — line 247

Emergency removal of an approved oracle (#1688) — unconditional, like
`remove_approved_vault`.

### pub fn `remove_supported_token` — line 285

Emergency removal of a supported token (#1688) — unconditional, like
`remove_approved_vault`.

### pub fn `deprecate_approved_vault` — line 314

Mark an approved vault as deprecated (#1688).

A deprecated vault is no longer accepted for new arenas, but the
arenas that already use it stay readable and settleable: the arena
contract talks to the vault directly and never consults the factory's
approval flags.

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.

### pub fn `disable_approved_vault` — line 340

Disable an approved vault (#1688).

Refused while the vault still carries liabilities: pools that are
still live, or pools created before the registry tracked their
integrations. The emergency path (`remove_approved_vault`) is not
affected by this guard.

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.
- `FactoryError::OutstandingLiabilities` if the vault is still in use.

### pub fn `reactivate_approved_vault` — line 358

Bring a deprecated vault back into service (#1688).

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.
- `FactoryError::IntegrationNotApproved` if the vault is not approved.

### pub fn `deprecate_approved_oracle` — line 377

Mark an approved oracle as deprecated (#1688).

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.

### pub fn `disable_approved_oracle` — line 398

Disable an approved oracle (#1688).

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.
- `FactoryError::OutstandingLiabilities` if the oracle is still in use.

### pub fn `reactivate_approved_oracle` — line 420

Bring a deprecated oracle back into service (#1688).

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.
- `FactoryError::IntegrationNotApproved` if the oracle is not approved.

### pub fn `deprecate_supported_token` — line 439

Mark a supported stake token as deprecated (#1688).

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.

### pub fn `disable_supported_token` — line 460

Disable a supported stake token (#1688).

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.
- `FactoryError::OutstandingLiabilities` if the token is still in use.

### pub fn `reactivate_supported_token` — line 482

Bring a deprecated stake token back into service (#1688).

#### Errors
- `FactoryError::Unauthorized` if the caller is not the factory admin.
- `FactoryError::IntegrationNotApproved` if the token is not supported.

### pub fn `get_vault_lifecycle` — line 502

The lifecycle record of an approved vault (#1688).

An entry that predates the lifecycle — an unknown legacy entry — reads
as `Active` with ledger `0` and reason `legacy`, so existing
integrations keep working unchanged.

### pub fn `get_oracle_lifecycle` — line 507

The lifecycle record of an approved oracle (#1688).

### pub fn `get_token_lifecycle` — line 512

The lifecycle record of a supported stake token (#1688).

### pub fn `get_registry_revision` — line 520

The current registry revision (#1688).

Bumped on every lifecycle change. Off-chain caches record the revision
they were built from and invalidate themselves when it moves.

### pub fn `count_live_pools_using` — line 530

How many live pools still carry a liability against an integration
(#1688).

Counts the pools the registry has tracked since it started recording
integrations. Pools created before that are not counted here — they
are what makes `disable_*` refuse: see `require_no_liabilities`.

### pub fn `list_supported_tokens` — line 535

Returns up to 50 supported tokens starting at the requested offset.

### pub fn `get_active_pool_count` — line 559

Return how many Active pools `host` currently has (#1572).

Read-only. Lets off-chain rematch tooling check the host's
`max_active_pools` headroom before prompting them to create a
rematch pool.

### pub fn `pause` — line 564

Pause the factory, blocking new pool creation.

### pub fn `unpause` — line 572

Unpause the factory, resuming normal operations.

### pub fn `set_global_pause` — line 590

Set or clear the protocol-wide emergency pause (#1583).

While set, every arena deployed by this factory rejects its
fund-moving entry points with `ArenaError::GloballyPaused`, on top of
(not instead of) each arena's own host-controlled pause. Only the
protocol admin may call this. The admin is expected to be a Stellar
multisig account whose medium threshold needs two signers, so the
call carries two-person approval through `require_auth`.

#### Events
Emits `GPAUSE` with `(paused, reason)`.

### pub fn `is_globally_paused` — line 600

Whether the protocol-wide emergency pause is set (#1583). Read by every
arena's fund-moving entry points.

### pub fn `admin` — line 616

The factory's current protocol admin (#1629).

Every arena this factory deploys reads this address to resolve its
protocol-admin role — the powers over an arena that its host must not
hold: upgrading the arena's WASM, changing the platform fee, pausing
it, and force-cancelling it. Reading the admin here rather than
caching it per arena means a factory-level admin rotation
(`propose_admin` / `accept_admin`) withdraws the old admin's powers
over every arena at once.

Panics when the factory has not been initialised, because there is no
admin to name in that case.

### pub fn `release_arena` — line 639

Release an arena from a creator's active pool count.

Called by the arena contract itself (verified via creator stake record)
when the arena finishes or is cancelled. Decrements the creator's active
pool count, allowing the creator to deploy new arenas.
Deliberately **not** gated on `is_paused` (#1360).

Pause exists to stop new activity — chiefly `create_pool`. This is the
opposite: a bookkeeping decrement for an arena that has already finished
or cancelled, triggered by that arena's own lifecycle, not by a user
starting something new.

Gating it caused permanent damage. The arena calls this exactly once, via
`try_release_arena`, with no retry path. If the factory happened to be
paused at that moment the call failed silently, while the neighbouring
`try_reclaim_creator_stake` — which has no pause check — still succeeded
and removed the stake record. Any later retry then fails with
`ArenaNotFound`, so the creator loses one `max_active_pools` slot forever,
for an arena that has already fully completed.

### pub fn `reclaim_creator_stake` — line 818

Refund a creator's locked stake once their arena has completed.

Authorised by the `arena` itself: a deployed arena releases its creator
stake as part of reaching a terminal state, which is the on-chain
"arena completed" gate — a host cannot pull their own stake early. The
recorded amount is transferred from the factory back to the creator and
the stake record is cleared so it cannot be reclaimed twice.

### pub fn `update_arena_status` — line 929

Update the status of a deployed arena pool.

Only callable by the arena contract itself. The calling arena's address
must match the recorded arena_address for the given pool_id.

### pub fn `get_arena` — line 975

Get metadata for a specific arena pool by pool_id.

### pub fn `get_arenas` — line 984

Get a paginated list of all arena pools.

`offset` is the number of pools to skip (0-indexed).
`limit` is the maximum number of pools to return (clamped to 50).
Pools are returned in creation order (pool_id ascending).

### pub fn `get_arenas_by_host` — line 1004

#1613: Return pools created by `host`, paged by `page` (0-indexed).

Each page contains up to `HOST_POOLS_PAGE_SIZE` pool IDs.  The caller
iterates pages until an empty page is returned.

### pub fn `get_arenas_by_status` — line 1021

#1613: Return pools in `status`, paged by `offset` / `limit`.

Uses the StatusBucket secondary index.  Stable ordering is NOT
guaranteed across status transitions (swap-remove may reorder IDs).

## `contract/factory/src/storage.rs`

### pub fn `save_approved_vault_token` — line 197

Record the stake token `vault` was approved with (#1634).

### pub fn `load_approved_vault_token` — line 205

The stake token `vault` was approved with, or `None` if it was never
approved, was removed, or was approved before #1634.

### pub fn `is_globally_paused` — line 307

Protocol-wide emergency pause read by every arena (#1583).

Kept in instance storage: invoking the factory already loads its
instance entry, so an arena's cross-contract check adds no further
ledger entry. The read never extends a TTL.

### pub fn `index_host_pool` — line 439

Append `pool_id` to the host's pool index, spilling into a new page
once the current one holds `HOST_POOLS_PAGE_SIZE` entries.

### pub fn `host_pool_count` — line 454

Total pools indexed for `host` across all pages.

### pub fn `get_host_pools_page` — line 462

Return page `page` (0-indexed) of the host's pool-ID index. An empty
page means the caller has iterated past the end.

### pub fn `index_pool_status` — line 491

Add `pool_id` to `status`'s bucket. Idempotent: re-indexing an ID that
is already present is a no-op.

### pub fn `transition_pool_status` — line 501

Move `pool_id` from the `from` bucket to the `to` bucket using an
O(1) swap-remove — bucket order is not stable across transitions.

### pub fn `get_pools_by_status` — line 522

Slice the `status` bucket at `offset` / `limit` (clamped to
`MAX_ARENAS_PAGE_SIZE`). Ordering is NOT stable across transitions.

### pub fn `arena_status_ordinal` — line 536

Wire ordinal for `status`, used by the versioned `pool_st` event payload.

### pub fn `save_lifecycle` — line 548

Record the lifecycle state of a registry entry.

### pub fn `load_lifecycle` — line 556

The lifecycle record of a registry entry, or `None` for an entry that
predates the lifecycle (#1688).

### pub fn `registry_revision` — line 571

The current registry revision (#1688). Bumped on every lifecycle
change so caches can be invalidated without replaying events.

### pub fn `bump_registry_revision` — line 576

Bump the registry revision and return the new value (#1688).

### pub fn `save_pool_integration` — line 584

Record the integrations a pool was created with (#1688).

### pub fn `load_pool_integration` — line 592

The integrations a pool was created with, or `None` for a pool that
predates the registry tracking (#1688).

### pub fn `increment_live_use` — line 598

Record one more live pool against an integration (#1688).

### pub fn `decrement_live_use` — line 606

Drop one live pool from an integration (#1688).

### pub fn `live_use` — line 617

How many live pools still carry a liability against an integration
(#1688). Counts pools created since the registry started tracking
integrations.

## `contract/factory/src/types.rs`

### pub fn `clamp_page_size` — line 13

Clamp a caller-supplied page size to `[0, MAX_ARENAS_PAGE_SIZE]`.
Clamping (not rejecting) preserves the existing read-only ABI behaviour.
