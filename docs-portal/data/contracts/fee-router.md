# fee-router contract API

Source: `contract/fee-router/src`

## `contract/fee-router/src/lib.rs`

### pub trait `StakingInterface` — line 33

Minimal interface for the staking contract we call into.

Kept as a local stub (not `use staking::StakingContractClient`) for the
same reason `factory` avoids importing `arena` as a non-dev dependency:
doing so would link both `#[contractimpl]` blocks into a single binary and
produce duplicate exported symbols at link time.

### fn `distribute_rewards` — line 38

Distribute `amount` tokens as staking rewards.

The caller must authorise the call and must have approved the staking
contract to pull `amount` from their token balance before calling this.

### fn `total_shares` — line 41

Returns the current total shares outstanding in the staking pool.

### pub fn `initialize` — line 61

Initialise the fee router.

* `admin`            — address allowed to change governance parameters.
* `staking_contract` — address of the staking contract to route into.
* `treasury`         — address that receives the non-staking share.
* `staking_share_bps`— initial split in basis points (0–10 000).

### pub fn `version` — line 89

Return the contract ABI version.

### pub fn `receive_fees` — line 102

Receive arena platform fees into the router.

Callable by anyone (typically the arena settlement path).  The caller
must have approved the fee router to pull `amount` of `token` from
their address before invoking this.

Fees accumulate per-token until `flush` is called.

### pub fn `flush` — line 151

Flush accumulated fees for `token`.

Callable by anyone.

##### Split logic

1. If the accumulated balance is below `MIN_FLUSH_AMOUNT`, return
   `BelowMinFlushAmount` (deferred, not reverted — the balance is
   preserved).
2. Only the *staking token* (the token configured in the staking
   contract) is routed to `staking.distribute_rewards`.  Any other fee
   token goes entirely to the treasury.
3. If the staking pool holds zero shares, the staking portion is
   accumulated into the treasury transfer (deferred, not lost) and
   `StakingPoolEmpty` is returned.  This makes `flush` idempotent: the
   caller can retry after the first staker deposits.

##### Events

On a successful full flush:
* `FEE_FLUSH` — `(token, total, staking_amount, treasury_amount)`

On a deferred staking portion (pool empty):
* `FEE_DEFR`  — `(token, deferred_amount)`

### pub fn `propose_staking_share` — line 273

Propose a new `staking_share_bps` value.

Takes effect only after `commit_staking_share` is called, which can
happen no earlier than `STAKING_SHARE_TIMELOCK_SECS` seconds later.

### pub fn `commit_staking_share` — line 298

Commit the pending `staking_share_bps` change after the timelock.

Callable by anyone once the timelock has elapsed.

### pub fn `cancel_staking_share` — line 315

Cancel a pending staking-share change (admin only).

### pub fn `set_treasury` — line 327

Update the treasury address (admin only).

### pub fn `set_staking_contract` — line 336

Update the staking contract address (admin only).

### pub fn `propose_admin` — line 351

Propose a new admin (admin only).  The proposed address must call
`accept_admin` to complete the transfer.

### pub fn `accept_admin` — line 360

Accept an admin transfer (proposed address only).

## `contract/fee-router/src/tests.rs`

### pub fn `distribute_rewards` — line 50

Mimics the real staking contract: pulls `amount` tokens from
`caller` with a plain `transfer`, exactly as
`staking::distribute_rewards` does (not `transfer_from`).
