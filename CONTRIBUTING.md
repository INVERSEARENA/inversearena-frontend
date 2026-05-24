# Contributing to InverseArena

## Snapshot Testing

Soroban stores all `#[contracttype]` values using XDR serialization. A change to a `contracttype` struct (adding, removing, or reordering fields) silently breaks deserialization of existing ledger entries.

To prevent this, we use snapshot tests that assert the XDR serialization of every `contracttype` matches a hard-coded byte array.

### How it works

Every contract (`arena`, `factory`, `payout`, `staking`) has a `snapshot_test.rs` module. These tests:
1. Construct a sample value of a `#[contracttype]`.
2. Serialize it to XDR bytes.
3. Assert that the bytes match a hard-coded expected array.

### Adding new types

When you add a new `#[contracttype]`, you **must** add a corresponding snapshot test in the relevant contract's `snapshot_test.rs`.

### Updating snapshots

If you intentionally make a breaking change to a `contracttype` (e.g., adding a field), the snapshot tests will fail. To update them:
1. Run the tests with nocapture to see the actual bytes:
   ```bash
   cargo test test_snapshots --manifest-path contract/<contract_name>/Cargo.toml -- --nocapture
   ```
2. Copy the "Actual" byte array from the test output.
3. Update the hard-coded byte array in `snapshot_test.rs`.
4. Document why the breaking change was necessary in your pull request.
