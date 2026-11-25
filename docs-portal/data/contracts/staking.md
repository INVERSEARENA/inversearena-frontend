# staking contract API

Source: `contract/staking/src`

## `contract/staking/src/lib.rs`

### pub fn `initialize` — line 102

Initialize the staking contract.

#1012: Now emits an `INIT` event with admin and token addresses
so off-chain indexers can detect contract setup.

### pub fn `version` — line 139

Return the staking contract ABI/storage version.

### pub fn `stake` — line 266

Deposit `amount` tokens and mint the caller a pro-rata share of the pool.

Shares are minted `amount * total_shares / total_staked`, or one-for-one
when the pool is empty. Two guards make that accounting resistant to the
share-inflation attack described on `MIN_INITIAL_STAKE`: the deposit that
seeds an empty pool must be at least `MIN_INITIAL_STAKE`, and any deposit
whose share count rounds down to zero is rejected rather than absorbed by
the existing stakers.

#### Errors
- `StakingError::InvalidAmount` if `amount` is not positive.
- `StakingError::BelowMinimumInitialStake` if the pool holds no shares
  and `amount` is under `MIN_INITIAL_STAKE`.
- `StakingError::ZeroShares` if `amount` is too small relative to the
  pool's current value to mint a single share.

### pub fn `unstake` — line 340

Unstake `shares` and return the proportional token amount.

#1011: Guards against division by zero when `total_shares` is 0.

### pub fn `min_initial_stake` — line 411

The minimum deposit accepted while the pool holds no shares.

Exposed so clients can validate a first deposit before submitting it
rather than surfacing `StakingError::BelowMinimumInitialStake`.

### pub fn `upgrade` — line 480

Upgrade the staking contract's code to `new_wasm_hash`.

Admin-gated. Upgrading in place preserves all state — admin, token,
global share/stake totals, and every staker position — so a bug in
share accounting or token transfer logic can be fixed without
redeploying and losing staker positions.

### pub fn `storage_inventory` — line 515

Read-only inventory of the contract's critical global storage keys
(#1516).

Returns one row per critical key with its presence flag. Callable by
anyone: it exposes only the contract's own aggregate/admin key
inventory, never per-staker data. The keeper intersects these keys with
RPC `getLedgerEntries` `liveUntilLedgerSeq` to compute TTL headroom —
a contract cannot read its own entry TTL at runtime.

### pub fn `renew_storage` — line 532

Extend the TTL of every present critical global key (#1516).

Admin-gated and idempotent: `extend_ttl` only extends entries whose
remaining TTL is at or below `PERSISTENT_TTL_THRESHOLD`, so repeated
calls inside the threshold are no-ops. A contract cannot read its own
entry TTL, so this method intentionally reports nothing beyond success —
the keeper determines what actually moved by re-reading
`liveUntilLedgerSeq` over RPC after the transaction confirms.
