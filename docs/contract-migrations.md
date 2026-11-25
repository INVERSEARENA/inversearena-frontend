# Contract Storage Migrations (#1842)

## Pattern
All Soroban contracts expose:
- `storage_version() -> u32`
- `migrate(caller, max_steps) -> Result<u32, ...>` (admin/protocol-authorized, idempotent)

State-changing entrypoints must reject old layouts with `MigrationPending`.

## Upgrade path
1. Deploy new WASM.
2. Invoke contract `upgrade(new_wasm_hash)` (admin-gated).
3. Call `migrate(caller, max_steps)` until returned version == current.
4. Verify `storage_version()` and run smoke reads/writes.

## Arena notes
Arena keeps `DataKey::StorageVersion` and roster migration. Migration is idempotent; future migrations should use `max_steps` for chunked progress.

## Testing
Add WASM-upgrade fixtures: deploy vN, populate state, upgrade to vN+1, run `migrate`, assert invariants and idempotency.
