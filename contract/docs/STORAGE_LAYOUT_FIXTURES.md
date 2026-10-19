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

## Upgrade note — ArenaConfig v2 → v3 (#1552 / #1554)

`ArenaConfig` gained two fields:

- `reveal_deadline: u64` (#1552) — commit and reveal phases are now distinct.
- `treasury: Address` (#1554) — the platform-fee destination.

`#[contracttype]` structs are encoded as field-name-keyed maps, and a map with the
wrong number of entries aborts at the host level when decoded (it cannot be caught
as a Rust `Err`), so `ArenaStorage::load_config` inspects the encoded map for the
`reveal_deadline` key and selects a decoder:

- **current layout** → `ArenaConfig`;
- **v2 layout** → `LegacyArenaConfigV2`, migrated in place and re-saved. A legacy
  arena has no reveal window (`reveal_deadline = 0`, preserving the old
  "resolve at commit deadline / unbounded reveal" timing) and no treasury
  (`treasury = admin`).

This is additive-only; no player, round, yield, or roster storage is reshaped, so
no `migration_boundary` player-data migration is required. Covered by
`storage::tests::legacy_arena_config_is_migrated_in_place`.
