# Contributing to InverseArena

## Smart Contract Code Review Checklist

Every PR that touches a contract function which moves funds (transfers tokens,
interacts with a vault, pays out prizes, etc.) must be reviewed against the
checks-effects-interactions pattern. Reviewers should confirm each of the
following before approving:

- [ ] **Checks first.** All input validation, auth (`require_auth`), state
  preconditions (e.g. `GameState`), and "already done" guards
  (e.g. `prize_claimed`) run before any state write.
- [ ] **Effects next.** Every persistent storage write that records the
  outcome of the operation (state transitions, flags such as
  `mark_prize_claimed`, counters, balances) is committed *before* any
  cross-contract call.
- [ ] **Interactions last.** Cross-contract calls — token transfers, vault
  withdrawals, oracle reads that can have side effects — happen only after
  all state has been persisted. The function should not write to storage
  after a cross-contract call returns.
- [ ] **No "guard after transfer".** A flag like `prize_claimed` or
  `state = Settled` must never be set after a `token.transfer`,
  `rwa.withdraw_all`, or similar external invocation. A malicious token
  contract could re-enter and replay the operation before the flag is set.
- [ ] **Reentrancy regression test.** Any new or modified fund-moving function
  has a unit test that pre-sets the relevant guard flag (simulating mid-call
  reentry) and asserts the function returns the corresponding `AlreadyX`
  error.

See `contract/arena/src/lib.rs::claim` for the canonical example of this
ordering.

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
