# Inverse Arena — storage and gas bounds

The arena contract stores **one persistent entry per participant** (`Survivor`) and **one per submission** (`Submission(round, player)`). Unbounded growth would risk hitting Soroban storage limits and inflating per-transaction gas.

## Constants (source of truth)

Defined in `contract/arena/src/bounds.rs`:

| Constant | Release build (`not(test)`) | Purpose |
|----------|-----------------------------|---------|
| `MAX_ARENA_PARTICIPANTS` | `10_000` | Hard ceiling on joins; also interacts with admin `set_capacity` (effective cap is `min(capacity, MAX_ARENA_PARTICIPANTS)` when `capacity > 0`). |
| `MAX_SUBMISSIONS_PER_ROUND` | `10_000` | Hard ceiling on distinct submitters per active round. |
| `MIN_REQUIRED_STAKE` | `10_000_000` | Minimum `required_stake_amount` accepted by `init()`. Equals 10 XLM in stroops (7-decimal token). Matches the factory's `DEFAULT_MIN_STAKE` to prevent dust-stake arenas and enforce a consistent floor regardless of whether the arena was created via the factory or directly. |

**Test builds** (`cfg(test)`) use smaller values (`64` participants, `32` submissions per round) so CI can run **N−1 / N / N+1** boundary tests quickly.

## Typed errors

| Error | When |
|-------|------|
| [`ArenaError::ArenaFull`](arena/src/lib.rs) | Join would exceed the effective participant cap. |
| [`ArenaError::MaxSubmissionsPerRound`](arena/src/lib.rs) | `submit_choice` would exceed `MAX_SUBMISSIONS_PER_ROUND`. |

## Versioning

Raising or lowering these limits is a **contract behaviour change**. Bump the on-chain contract version / migration notes when you change defaults, and update `abi_snapshot.json` if error ordinals change.
