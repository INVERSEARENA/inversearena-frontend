# rwa-adapter contract API

Source: `contract/rwa-adapter/src`

## `contract/rwa-adapter/src/events.rs`

### pub fn `initialized` — line 24

Emitted when the adapter is initialized.

```text
topic[0] = "rwa"
topic[1] = "init"
data     = (v=1, admin: Address, stake_token: Address, oracle: Address)
```

### pub fn `deposited` — line 42

Emitted when funds are deposited into the adapter.

```text
topic[0] = "rwa"
topic[1] = "deposit"
topic[2] = depositor address  (indexed)
data     = (v=1, amount: i128)
```

Previously the amount was in topics (making it unindexable and bloating
the topic array).  Moved to data per normalization convention (#1607).

### pub fn `withdrawn` — line 57

Emitted when funds are withdrawn from the adapter.

```text
topic[0] = "rwa"
topic[1] = "withdraw"
topic[2] = recipient address  (indexed)
data     = (v=1, amount: i128)
```

### pub fn `yield_harvested` — line 71

Emitted when yield is harvested and distributed.

```text
topic[0] = "rwa"
topic[1] = "yield"
data     = (v=1, yield_amount: i128, new_index: i128)
```

### pub fn `admin_changed` — line 79

Emitted when the admin transfers admin rights.

### pub fn `upgraded` — line 87

Emitted when the WASM is upgraded.

## `contract/rwa-adapter/src/lib.rs`

### pub fn `withdraw` — line 183

Withdraw `amount` tokens from `from`'s position, leaving the remainder
(including any accrued yield) in place.

The arena uses this to refund a single player's entry fee out of the
pooled arena position without unwinding the whole position (#1580,
#1581). Yield accrued on the withdrawn principal is forfeited to the
remaining pool: the number of principal shares burned is rounded up so
the caller can never receive more value than the shares removed.

The payout is capped by the vault's actual token balance, exactly like
`withdraw_all`; a shortfall is surfaced with the `short` event and the
returned value is what was actually paid.

### pub fn `config` — line 304

Return the stake token and oracle this vault was initialised with
(#1634).

The factory reads this when a vault is approved and again on every
`create_pool`, rejecting an arena whose `stake_token` or
`oracle_contract` differs from the vault's.

#### Errors
- `RwaError::NotInitialized` if `initialize` has not been called.

### pub fn `sync` — line 349

Checkpoint the index using the previous rate, then begin applying the
oracle's current rate from this ledger onward.

### pub fn `propose_admin` — line 358

Propose a new admin. The current admin must authorize the proposal.
The proposed admin must call `accept_admin` to complete the transfer.

### pub fn `accept_admin` — line 366

Accept a pending admin transfer. Only the proposed admin may call this.

## `contract/rwa-adapter/src/oracle.rs`

### pub trait `OracleScheduleInterface` — line 28

Schedule-reading client for keepers and frontends (#1570).
Kept separate from [`OracleInterface`] so existing callers and mocks
that only implement `get_current_yield_bps` keep compiling.

### pub fn `fetch_yield_bps` — line 38

Read the currently effective yield rate in bps.

The oracle bounds each update by `max_delta_bps` and activates it after
`activation_delay` (#1570); `get_current_yield_bps` already returns the
effective rate, so vault math needs no schedule tracking. Returns `0`
when the oracle is unreachable — liveness over precision.

### pub fn `fetch_rate_schedule` — line 51

Fetch the oracle's full rate schedule (#1570).

Returns `None` when the oracle is unreachable or is an older deployment
without `get_rate_schedule`. Keepers and frontends use this to surface
pending rates, activation times, and bounds before they take effect.
