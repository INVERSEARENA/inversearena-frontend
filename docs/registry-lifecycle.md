# Registry deprecation lifecycle (#1688)

## Problem

The factory's registry was binary: a stake token, yield vault or oracle was
either *approved* or not. There was no way to say "this integration is on its
way out". Operators who wanted to retire an integration had two options, both
bad:

- keep it approved forever, or
- remove it outright — which broke every arena that already used it, because
  the arena's settlement path needs the vault and the oracle to stay
  readable.

The lifecycle adds the missing middle state and makes removal safe:

| State | New arenas | Existing arenas | Meaning |
| --- | --- | --- | --- |
| `Active` | allowed | fully supported | the normal state |
| `Deprecated` | refused | fully supported | winding down — no new arena, existing arenas settle unchanged |
| `Disabled` | refused | supported while liabilities are open, refused afterwards | withdrawn |

An integration the factory has no record of reads as `Active` with ledger `0`
and reason `legacy`. That is what makes the feature safe to roll out: a
deployment that predates the lifecycle, or an entry that was approved before
the lifecycle existed, keeps working exactly as before.

## Contract surface

`contract/factory/src/types.rs`

- `RegistryState` — `Active`, `Deprecated`, `Disabled`.
- `RegistryEntry` — `{ state, effective_ledger, reason }`. `reason` is a
  `Symbol` so the reason is machine-readable in the event stream.
- `RegistryKind` — `Token`, `Vault`, `Oracle`.
- `PoolIntegration` — the token, vault and oracle a pool was created with.

`contract/factory/src/storage.rs`

- `DataKey::VaultLifecycle(Address)`, `DataKey::OracleLifecycle(Address)`,
  `DataKey::TokenLifecycle(Address)` — the lifecycle record per integration.
- `DataKey::RegistryRevision` — bumped on every lifecycle change.
- `DataKey::PoolIntegration(u32)` — the integration of each pool.
- `DataKey::LiveUse(RegistryKind, Address)` — how many pools still use the
  integration.

### Entry points

| Entry point | Effect |
| --- | --- |
| `add_approved_vault` / `add_approved_oracle` / `add_supported_token` | registers the integration as `Active` (reason `approved`) |
| `remove_approved_vault` / `remove_approved_oracle` / `remove_supported_token` | sets `Disabled` (reason `removed`) — unconditional, the emergency path |
| `deprecate_approved_vault` / `deprecate_approved_oracle` / `deprecate_supported_token` | sets `Deprecated` (reason `deprecating`), refuses while live pools use the integration |
| `disable_approved_vault` / `disable_approved_oracle` / `disable_supported_token` | sets `Disabled` (reason `disabled`), refuses while live pools use the integration |
| `reactivate_approved_vault` / `reactivate_approved_oracle` / `reactivate_supported_token` | sets `Active` (reason `reactd`), only for an integration that is still registered |

All of these are admin-only.

### Views

- `get_vault_lifecycle(address)`, `get_oracle_lifecycle(address)`,
  `get_token_lifecycle(address)` → the `RegistryEntry`.
- `get_registry_revision()` → the revision, bumped on every change.
- `count_live_pools_using(kind, address)` → how many pools still use the
  integration.

### Enforcement

`create_pool` refuses an integration that is not `Active`:

- a `Deprecated` or `Disabled` integration → `FactoryError::DeprecatedIntegration`
  (24);
- an integration that was never approved → `FactoryError::IntegrationNotApproved`
  (26).

`update_arena_status` releases the liability when a pool reaches `Finished`
or `Cancelled`, decrementing the live-use counters. A pool that was created
before the lifecycle existed has no `PoolIntegration` record; those pools are
counted as "untracked live pools" and block a `Disabled` transition until they
settle, so an integration can never be pulled out from under an arena.

## Operator runbook

### Deprecating an integration

1. Confirm no live pool still needs it:
   `count_live_pools_using(kind, address)` → `0`.
2. `deprecate_approved_vault(vault, "reason")` (or the oracle/token
   equivalent). The reason is stored on the entry and emitted in the event.
3. New arena creation now fails with `DeprecatedIntegration`. Existing arenas
   are untouched: their settlement path never consults the lifecycle.

The deprecation is reversible: `reactivate_approved_vault(vault, "reason")`
puts the integration back to `Active`.

### Withdrawing an integration

1. `deprecate_approved_vault(vault, "reason")` first — announce it.
2. Wait for the live pools to settle: `count_live_pools_using(kind, address)`
   → `0` (the counter drops when the arena reaches `Finished` or
   `Cancelled`).
3. `disable_approved_vault(vault, "reason")` — refused with
   `FactoryError::OutstandingLiabilities` (25) while anything is still live.

If an incident makes the wait unacceptable, `remove_approved_vault(vault)`
disables the integration unconditionally. It is the emergency path and it
bypasses the liability guard on purpose; it must be followed by a manual
audit of the pools that were still live.

### Cache invalidation

`get_registry_revision()` moves on every lifecycle change. It is the
cache-invalidation key for the backend and the clients:

- the backend caches a lifecycle snapshot for 30 seconds and re-reads it on
  expiry;
- the compatibility manifest carries `registryRevision`;
- a client holding a snapshot with an older revision knows it is stale
  without replaying events.

## Backend and API

- `backend/src/services/registryLifecycle.ts` — reads the lifecycle from the
  factory and caches it. A failed read reports `available: false` and every
  entry reads as `Active`: a read outage must never look like a deprecation.
- `GET /api/config/registry?token=C...&vault=C...&oracle=C...` — the
  lifecycle of the requested integrations plus the revision.
- `GET /api/config/registry/revision` — the revision alone, the cheap poll.
- `GET /api/config/compatibility` — the manifest, now including
  `registryRevision`.

## Client behaviour

- **Creator** (`frontend/src/components/modals/PoolCreationModal.tsx`): the
  lifecycle is read while the form is open. A deprecated or withdrawn
  integration is shown as a warning and the "Initialize Arena" button is
  disabled, so the creator is told *before* signing rather than after the
  transaction is rejected.
- **Player** (`frontend/src/features/arena-lobby/components/ArenaLobbyClient.tsx`):
  a deprecated integration in the arena's own configuration produces a notice
  that says the arena still settles and that claims and refunds are
  supported. It is deliberately **not** an "unsupported" label — that would
  read as "your claims are gone" when the opposite is true.

## Migration

Nothing has to be migrated. Existing approvals keep working: an integration
with no lifecycle record reads as `Active`. The only operator action is
optional — announce integrations you intend to retire by deprecating them,
so creators see the warning while the arenas that use them still settle.
