# payout contract API

Source: `contract/payout/src`

## `contract/payout/src/lib.rs`

### pub trait `ArenaSettlementInterface` — line 33

The one arena read the payout contract depends on (#1632). Local stub
rather than a dependency on the `arena` crate, whose `#[contractimpl]`
would otherwise be linked into this contract's wasm.

### pub trait `FactoryRegistryInterface` — line 39

The one factory read the payout contract depends on (#1632).

### pub fn `initialize` — line 72

One-time setup: the admin authorised to distribute, the payout token,
the factory whose registry identifies genuine arenas, and the initial
per-day outflow cap.

#### Errors
- `PayoutError::AlreadyInitialised` on a second call.
- `PayoutError::InvalidCap` if `daily_cap` is not positive.

### pub fn `version` — line 94

Return the payout contract ABI/storage version.

### pub fn `upgrade` — line 102

Upgrade this payout contract to `new_wasm_hash`.

Only the configured admin may perform upgrades so payout history remains
attached to the same contract instance.

### pub fn `payout_id` — line 114

The payout id for paying `recipient` out of `arena` (#1632):
`sha256(xdr(arena) ‖ xdr(recipient))`.

Derived rather than caller-chosen, so one arena prize maps to exactly
one id and can be paid at most once.

### pub fn `distribute_winnings` — line 138

Pay `winner` `amount` of the payout token for winning `arena`.

#### Errors
- `PayoutError::InvalidAmount` if `amount <= 0`.
- `PayoutError::AlreadyPaid` if `(arena, winner)` was already paid.
- `PayoutError::ArenaSettlementUnavailable` if the arena cannot report
  its settlement (not an arena, or WASM older than #1632).
- `PayoutError::UnknownArena` if the factory does not know the arena.
- `PayoutError::ArenaNotSettled`, `NotArenaWinner`, `ExceedsEntitlement`
  or `TokenMismatch` if the arena's own record does not support the
  payout.
- `PayoutError::DailyCapExceeded` if today's outflow would exceed the cap.
- `PayoutError::InsufficientBalance` if the contract cannot cover it.

#### Events
Emits `payout` with topics `(payout, winner)` and data
`(arena, payout_id, amount)`.

### pub fn `distribute_batch` — line 176

Pay several `(arena, recipient, amount)` entries in one transaction.

Every entry is validated exactly as `distribute_winnings` validates
one — entries may name different arenas — and the batch's total must
fit both the balance and today's remaining cap. Nothing is transferred
unless every entry passes.

#### Errors
Those of `distribute_winnings`, plus `EmptyBatch`, `BatchTooLarge`, and
`DuplicateRecipient` when two entries share an `(arena, recipient)`.

### pub fn `is_paid` — line 229

Whether `payout_id` (see `payout_id`) has been paid.

### pub fn `paid_amount` — line 234

The amount paid for `payout_id`, or `None` if it is unpaid.

### pub fn `propose_daily_cap` — line 251

Propose a new per-day outflow cap.

Lowering (or keeping) the cap takes effect immediately — tightening can
only reduce what a compromised key could move. Raising it is staged
and only `apply_daily_cap` after `CAP_TIMELOCK_SECONDS` makes it
effective, leaving a window to notice and rotate the admin. A new
proposal replaces any pending one.

#### Events
Emits `cap_set` with `cap` when applied immediately, or `cap_prop`
with `(cap, eta)` when staged.

### pub fn `apply_daily_cap` — line 274

Apply a staged cap increase once its timelock has elapsed.

#### Errors
- `PayoutError::NoPendingCap` if nothing is staged.
- `PayoutError::CapTimelockPending` before the staged `eta`.

### pub fn `cancel_daily_cap` — line 288

Discard a staged cap increase.

### pub fn `outflow_today` — line 305

Total paid out so far on the current UTC day.

## `contract/payout/src/storage.rs`

### pub fn `paid_amount` — line 221

Amount already paid for `payout_id`, if any.
