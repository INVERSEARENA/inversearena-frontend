# Soroban storage-layout compatibility fixtures (#1532)

ABI snapshots catch entrypoint drift; these fixtures document **persisted keys and contract types** that must remain readable after a WASM upgrade unless an explicit migration is shipped.

## Layout

- `contract/fixtures/storage-layout/arena-v1.json` — reviewable manifest (contract version, ledger metadata, schema checksum, persisted type inventory).
- `contract/arena/src/storage_layout_fixture.rs` — loads the manifest and proves canonical types still encode to stable XDR under candidate WASM.

## Refresh workflow

1. Bump `contract_version` / `schema_checksum` in the JSON manifest when storage shapes change intentionally.
2. Run `cargo test -p arena storage_layout_` locally and attach the PR diff for contract reviewers.
3. If the change is **breaking**, set `migration_boundary` in the fixture and add a dedicated migration integration test (out of scope for drive-by upgrades).

## CI

Contract CI runs the full workspace test suite, including `storage_layout_*` tests. Storage/key/discriminant failures surface as contract test failures distinct from ABI snapshot scripts.
