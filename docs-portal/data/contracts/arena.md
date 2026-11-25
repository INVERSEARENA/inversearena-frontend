# arena contract API

Source: `contract/arena/src`

## `contract/arena/src/eliminations.rs`

### pub fn `is_eliminated` — line 41

The least-selected *used* choice or choices survive. An unused option is
ignored when comparing the tally so an empty option cannot eliminate every
player. Binary ties preserve the established no-elimination behavior.

## `contract/arena/src/events.rs`

### pub fn `player_joined_sponsored` — line 51

Emitted for a sponsored ("Gift a seat") entry (#1715). Both addresses
are indexed: `payer` funded the fee and is the refund destination,
`player` owns the seat and receives any prizes. `player_count` is the
roster size after the join, matching `player_joined`.

### pub fn `player_left` — line 80

Emitted when a player withdraws from the lobby before the first round
(#1580). `player_count` is the roster size after the removal.

### pub fn `player_refunded` — line 87

Emitted when an entry fee is returned to a player who left or was banned
from the lobby before the first round (#1580, #1581).

### pub fn `round_resolved_v2` — line 136

Emitted alongside `round_resolved` (#1394) with enough data for a
client to independently recompute survivor membership: the full
heads/tails tally and the surviving choice (if any). Additive —
`round_resolved` keeps firing unchanged for existing consumers; this
is a *new* topic, not a payload change to an existing one, so no
existing indexer breaks by ignoring it.

`surviving_choice` is `None` encoded as `heads_count == tails_count`
when both are nonzero (a tie — nobody eliminated); callers should use
`crate::eliminations::surviving_choice` on the tally rather than
inferring it from a sentinel, since Soroban events cannot carry
`Option<Choice>` as a topic-friendly primitive here.

### pub fn `round_resolved_v3` — line 158

Three-choice proof event. `rslvd2` remains emitted unchanged for old
indexers; consumers that understand this event can verify all tallies.

### pub fn `vault_oracle_failed` — line 247

Emitted when the yield oracle cross-contract call fails. The arena falls
back to a 0-bps yield, but surfaces the failure so operators can detect a
misconfigured, unreachable, or malfunctioning oracle.

### pub fn `oracle_freshness_policy_updated` — line 253

Emitted by `set_oracle_freshness_policy` (#1512).

### pub fn `oracle_freshness_observed` — line 268

Emitted on every `resolve_round` attempt that reaches the oracle
freshness check (#1512), success or rejection — `classification_code`
is `OracleFreshness::as_code()`'s value.

### pub fn `oracle_stale_rejected` — line 277

Emitted when `resolve_round` refuses to proceed because the oracle's
observation is `Stale` (#1512).

## `contract/arena/src/lib.rs`

### fn `admin` — line 46

The factory's current protocol admin (#1629). The arena reads this to
resolve who holds the protocol powers — upgrade, platform fee, pause —
so a factory-level admin rotation takes effect on every arena at once.

### pub fn `initialize` — line 159

Initialise the arena with its immutable configuration.

Must be called exactly once before any other entry point. Sets the arena
state to `Open`, allowing players to join.

#### Parameters
- `admin`: Address that will control admin-only operations. Must authorize this call.
- `stake_token`: SAC token address used for entry fees and prize payouts.
- `yield_vault`: RWA adapter contract that earns yield on the staked principal.
  Initialization performs a shallow `balance_of` reachability/interface check;
  vault initialization state is enforced by later adapter calls.
- `entry_fee`: Exact token amount every player must stake to join.
- `oracle_contract`: On-chain oracle queried for the current yield rate on each round resolution.

#### Errors
- `ArenaError::AlreadyInitialized` if `initialize` has already been called.

#### Events
Emits `initialized` with the admin address.

### pub fn `version` — line 223

Return the arena contract ABI/storage version.

### pub fn `host` — line 235

Return the host of this arena — the address that runs the game and
moderates the lobby (#1629).

The host is stored in `ArenaConfig.admin`; the field keeps its old
name so the on-chain layout of every deployed arena stays readable.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.

### pub fn `protocol_admin` — line 248

Return the protocol admin of this arena (#1629) — the deploying
factory's current admin, which holds the arena's protocol powers:
upgrade, platform fee, pause and force-cancel.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
  protocol admin.

### pub fn `pause_expired` — line 258

Whether this arena's own pause has outlived
`MAX_PAUSE_DURATION_SECONDS` and therefore no longer blocks anything
(#1629).

`false` for an arena that is not paused.

### pub fn `propose_upgrade` — line 285

Propose an upgrade to `new_wasm_hash`.

Stores the proposal and records the current ledger timestamp. The upgrade
is NOT applied immediately — the protocol admin must call `execute_upgrade`
after `UPGRADE_TIMELOCK_SECONDS` have elapsed, giving users time to review
the new code.

Protocol-only (#1629): the host of the arena cannot upgrade it. The
protocol admin — the deploying factory's admin — must authorise this.

Callable while paused so an emergency pause can be followed by a
timelocked recovery upgrade. If a prior proposal exists it is silently
overwritten.

#### Errors
- `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
  protocol admin.

#### Events
Emits `upgrade_proposed`.

### pub fn `execute_upgrade` — line 310

Execute a previously proposed upgrade after the timelock has elapsed.

Only the protocol admin may execute (#1629). The timelock gives users a
window to review the proposed WASM hash before it takes effect.

#### Errors
- `ArenaError::NoPendingUpgrade` if no proposal exists.
- `ArenaError::UpgradeTimelockPending` if the timelock has not elapsed.
- `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
  protocol admin.

### pub fn `configure_player_limits` — line 341

Configure arena player bounds.

`min_players` must be at least 2 and cannot exceed `max_players`.
Existing participation is left untouched; the max applies to future
joins and the min applies to future `start_round` calls.

Limits freeze once the first player joins (#1640): players entered
under advertised terms, so the admin cannot later promise a smaller
field than the one recruited, nor a maximum below the count already
present.

#### Errors
- `ArenaError::ArenaAlreadyHasPlayers` if `player_count > 0`.
- `ArenaError::InvalidPlayerLimits` if `min > max`, `min < 2`, or
  `max > MAX_PLAYERS_ALLOWED`.

### pub fn `set_start_deadline` — line 371

Set the lobby start deadline (#1579).

Only the deploying factory may call this, immediately after
`initialize`, as part of `create_pool`. It is a separate entry point
because `initialize` already sits at Soroban's ten-parameter limit. Once
the deadline passes, `join_arena` rejects new entries and anyone may
call `cancel_unstarted`.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::InvalidGameState` if the lobby is no longer open.

### pub fn `set_option_count` — line 383

Configure the number of choices for a newly-created arena. The factory
is the only caller and sets this before the arena is available to players.

### pub fn `get_option_count` — line 399

Return the configured choice count (`2` for legacy instances).

### pub fn `get_start_deadline` — line 405

Return the lobby start deadline (#1579), or `0` if none is configured.
The lobby UI uses this for its countdown and refund-availability state.

### pub fn `ban_player` — line 426

Ban a player from joining this arena.

While the arena is still in its lobby (`round_count == 0`), a player who
has already joined is removed from the roster and refunded their entry
fee atomically (#1581). The ban flag persists so a future join attempt
is rejected with `PlayerBanned`.

Once the first round has started, banning is rejected with
`ArenaAlreadyStarted`. Allowing it would give the host a way to
eliminate players mid-game by removing them from an in-progress
roster, which the game's commit-reveal model must not permit.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ArenaAlreadyStarted` if at least one round has resolved.
- `ArenaError::VaultWithdrawFailed` if a joined player's refund cannot
  be released; the whole call reverts.

### pub fn `unban_player` — line 450

Remove a player's join ban.

### pub fn `is_player_banned` — line 459

Return whether a player is currently banned from joining.

### pub fn `join_arena` — line 481

Join the arena by staking the configured entry fee.

Transfers `entry_fee` tokens from the player to the arena contract and
forwards them into the yield vault. Joining is only allowed while the
arena is in the `Open` state.

#### Parameters
- `player`: Address of the joining player. Must authorize this call.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::InvalidGameState` if the arena is not in the `Open` state.
- `ArenaError::ArenaAlreadyStarted` if at least one round has been played,
  even though the arena is back in `Open` between rounds.

#### Events
Emits `player_joined` with the player address and updated total player count.

### pub fn `join_arena_for` — line 506

Join the arena with the entry fee funded by a different account
("Gift a seat", #1715).

Both addresses must authorize this call: `payer` authorizes the fee and
the top-level invocation, `player` consents to taking the seat. The fee
is transferred from `payer`, the seat and any prizes belong to `player`,
and cancellation refunds are returned to `payer` (recorded as the
sponsor). The sponsor is exposed through `get_player_status`.

#### Parameters
- `payer`: Address funding the entry fee and receiving refunds.
- `player`: Address registered as the player. Must authorize this call.

#### Errors
Same guards as `join_arena` (the payer is checked for the fee instead of
the player). The payer may be an existing player — gifting a seat to a
second account is allowed.

#### Events
Emits `player_joined_sponsored` with both the payer and player addresses
and the updated total player count.

### pub fn `leave_arena` — line 636

Leave an arena lobby before the first round and reclaim the entry fee
(#1580).

Allowed only while the arena is `Open` and no round has resolved. The
player's entry fee is released from the yield vault, the roster and
counters are updated, and the player state is removed so they may join
again later.

Yield policy: any yield accrued in the lobby on the departing player's
principal is forfeited to the pool and is not paid out. The refund is
therefore exactly `entry_fee`, matching the amount the player staked.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::InvalidGameState` if the arena is not in the `Open` state.
- `ArenaError::ArenaAlreadyStarted` if at least one round has resolved.
- `ArenaError::NotAPlayer` if the caller never joined.
- `ArenaError::VaultWithdrawFailed` if the vault cannot release the fee.

#### Events
Emits `player_left` and `player_refunded`.

### pub fn `submit_commitment` — line 677

Submit a blinded commitment to a coin-flip choice.

The player hashes their choice together with a secret salt and submits
only the hash. The actual choice is revealed later with `reveal_choice`.
This prevents other players from front-running the revealed choice.

#### Parameters
- `player`: Address of the committing player. Must authorize this call.
- `commitment`: SHA-256 hash of `[choice_byte] ++ salt_bytes`.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.

### pub fn `reveal_choice` — line 722

Reveal the choice committed with `submit_commitment`.

Verifies that `SHA-256([choice_byte] ++ salt_bytes)` matches the stored
commitment, then records the player's choice for the current round. Can
only be called after the `commit_deadline` timestamp has passed.

#### Parameters
- `player`: Address of the revealing player. Must authorize this call.
- `choice`: The coin-flip choice (`Heads` or `Tails`).
- `salt`: The 32-byte random nonce used when hashing the original commitment.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::ChoiceAlreadyRevealed` if this player has already revealed for the current round.
- `ArenaError::RoundNotActive` if the `commit_deadline` has not yet elapsed.
- `ArenaError::MissingCommitment` if no commitment was submitted for this player.
- `ArenaError::InvalidReveal` if the revealed choice and salt do not match the stored commitment.
- `ArenaError::NotAPlayer` if the caller never joined the arena.
- `ArenaError::PlayerEliminated` if the caller is no longer an active player.

### pub fn `cancel_arena` — line 768

Cancel the arena and refund all entry fees to players.

Only callable by the admin while the arena is still `Open`. Transitions
the arena to `Cancelled`, withdraws all principal from the yield vault,
and transfers each player's `entry_fee` back to their address.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::InvalidGameState` if the arena is not in the `Open` state.

### pub fn `cancel_unstarted` — line 806

Cancel an arena that never started once its start deadline has passed
(#1579).

Permissionless: any caller may trigger this after `start_deadline` while
the first round has not resolved. It reuses the normal cancellation
path, so the arena becomes `Cancelled`, every joined player can claim a
refund, and the creator stake is returned to the host. Without this,
entry fees would stay locked forever in an arena that never reaches
`min_players`.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::InvalidGameState` if the arena is not in the `Open` state.
- `ArenaError::ArenaAlreadyStarted` if at least one round has resolved.
- `ArenaError::NoStartDeadline` if this arena has no deadline configured.
- `ArenaError::DeadlineTooSoon` if the deadline has not been reached.

#### Events
Emits `arena_cancelled`.

### pub fn `expire_arena` — line 861

Expire a stuck arena, making every joined player refundable.

Any caller may trigger this when the arena is `Active` and the current
round's commit deadline has already passed, i.e. the arena is stuck
because no one called `resolve_round`.

Transitions to `Cancelled` and lets every player who ever joined —
including those already eliminated — reclaim their entry fee through
`claim_refund`, exactly as `force_cancel_arena` does (#1359).

This previously transitioned to `Finished` and pushed `entry_fee` only to
players still `active`. Eliminated players' stakes then had no path out of
the contract at all: `claim` requires a `stored_winner` that expiry never
set, and no sweep existed. An arena that expired mid-game therefore
stranded every eliminated player's stake permanently — while the *same*
arena cancelled by an admin refunded all of them.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::InvalidGameState` if the arena is not in the `Active` state.
- `ArenaError::DeadlineTooSoon` unless `now > commit_deadline +
  EXPIRY_GRACE_SECONDS` (#1627).

#### Security (#1627)
Expiry is gated by `EXPIRY_GRACE_SECONDS` after the commit deadline, not
by the deadline itself. The deadline is also when reveals open and
`resolve_round` becomes callable, so an earlier gate would let any
account cancel the game before reveals or resolution, forcing refunds
and letting a losing player escape elimination.

### pub fn `get_players` — line 905

Return a paginated list of all players and their current state.

Pages are zero-indexed and contain up to 50 entries each. Returns an
empty list when `page` is out of range.

#### Parameters
- `page`: Zero-based page index.

### pub fn `player_count` — line 921

Return the total number of players who have ever joined this arena.

Returns `0` if the contract has not been initialised.

### pub fn `get_player_status` — line 939

Return every per-player fact needed to gate arena actions in one read
(#1582): roster membership, liveness, commit/reveal status for the
current round, elimination round and reason, refund and winner flags,
and the current round and phase.

An address that never joined (or left the lobby) yields
`joined: false` rather than an error. The read writes nothing, does not
extend TTLs, and touches at most five storage entries (the sponsor key
added in #1715 is read only for joined players).

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.

### pub fn `get_settlement` — line 999

Return what this arena owes and to whom (#1632).

The payout contract reads this before paying anything for the arena:
the recipient must be `winner` and the amount at most `prize`. The
read writes nothing.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.

### pub fn `get_pool_config` — line 1026

Return this arena's full pool configuration (#1572).

Read-only. Off-chain rematch prefills read this so a rematch pool is
derived from the arena's own on-chain config rather than cached UI
state. Field names mirror the factory's `PoolConfig`.

`round_duration` is `0` until the first round has started — the
duration is recorded at `start_round`, not `initialize`.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.

### pub fn `start_round` — line 1065

Start a new commit-reveal round.

Only callable by the admin while the arena is `Open`.
Transitions the arena to `Active` and records
the round start timestamp. Players must submit commitments before
`duration_seconds` elapses, after which reveals are accepted.

#### Parameters
- `duration_seconds`: Length of the commit window in ledger seconds.
  Must be in range [`MIN_ROUND_DURATION_SECONDS`, `MAX_ROUND_DURATION_SECONDS`].
  When this many seconds have passed since the round start, `resolve_round`
  becomes callable.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::InvalidDuration` if `duration_seconds` is outside
  [`MIN_ROUND_DURATION_SECONDS`, `MAX_ROUND_DURATION_SECONDS`].
- `ArenaError::InvalidGameState` if the arena is not in the `Open` state.

#### Events
Emits `game_started` with the round number and duration.

### pub fn `start_next_round` — line 1120

Start a subsequent round with the stored duration after the host has
missed the inter-round grace period.

### pub fn `resolve_round` — line 1179

Resolve the current round by tallying revealed choices and eliminating the majority.

Only callable by the admin after the grace period (`round_start +
duration_seconds`) has elapsed. Computes which choice was in the
majority, marks those players as eliminated, snapshots the vault yield,
and transitions the arena:
- back to `Open` if more than one survivor remains
- to `Finished` if exactly one survivor remains (winner announced)
- to `Cancelled` if zero survivors remain (no winner; enables refund recovery via `claim_refund`)

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::RoundNotActive` if the arena is not in the `Active` state.
- `ArenaError::RoundNotStarted` if no round start timestamp is recorded.
- `ArenaError::GracePeriodNotElapsed` if the round duration has not yet passed.
- `ArenaError::StaleOracleData` if the oracle's latest observation is older than
  this arena's configured `max_age_secs` (#1512), or was never recorded. Recoverable:
  retry once the oracle has published a fresh observation. Does not apply when the
  oracle is merely unreachable or predates freshness metadata — that case keeps the
  existing liveness-first 0-bps fallback (see `oracle::fetch_yield_bps`).

#### Events
Emits `round_resolved` with the round number, eliminated count, and survivor count.
Emits `game_finished` with the winner address and round number if exactly one survivor remains.
Emits `oracle_freshness_observed` with this round's oracle freshness classification and age (#1512).
Emits `oracle_stale_rejected` instead of the above when the resolution is rejected for staleness.

### pub fn `claim` — line 1362

Claim the prize pool as the last surviving player.

Implements checks-effects-interactions: the prize-claimed flag and arena
state are persisted to `Settled` *before* any token transfer, so a
malicious re-entrant call via the stake token sees the flag and fails
with `ArenaError::PrizeAlreadyClaimed`.

Payout = staked principal + accumulated vault yield, capped to the
amount actually withdrawn from the vault.

#### Parameters
- `winner`: Address of the last surviving player. Must authorize this call.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.
- `ArenaError::GameNotFinished` if the arena is not in the `Finished` state.
- `ArenaError::PrizeAlreadyClaimed` if the prize has already been paid out (guards re-entrancy).
- `ArenaError::PlayerEliminated` if the caller was eliminated and is not the surviving winner.

#### Events
Emits `prize_claimed` with the winner address, total payout, and yield portion.

### pub fn `propose_admin` — line 1430

Propose a new admin address to take over contract administration.

Begins a two-step admin transfer. The proposed address is stored as a
pending admin; control does not change until the new admin calls
`accept_admin`. Only the current admin can call this.

#### Parameters
- `new_admin`: Address being nominated to become the next admin.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.

### pub fn `accept_admin` — line 1450

Accept a pending admin transfer initiated by `propose_admin`.

Only the address stored as the pending admin may call this. On success,
the pending admin record is deleted and the caller becomes the new admin.

#### Errors
- `ArenaError::NoPendingAdmin` if no admin transfer has been proposed.
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::ContractPaused` if the contract is paused.

#### Events
Emits `admin_changed` with the old and new admin addresses.

### pub fn `change_admin` — line 1474

Backward-compatible alias for `propose_admin`.

Stages an admin transfer; the proposed admin must still call
`accept_admin` before control changes hands. Prefer `propose_admin`
for new integrations.

#### Parameters
- `new_admin`: Address being nominated to become the next admin.

#### Errors
See `propose_admin`.

### pub fn `pause` — line 1507

Pause the contract, blocking all state-mutating gameplay entry points.

While paused, calls to `join_arena`, `submit_commitment`, `reveal_choice`,
`resolve_round`, and `claim` all fail with `ArenaError::ContractPaused`.
Read-only queries are unaffected.

Protocol-only (#1629): the host of the arena cannot pause it. The
protocol admin — the deploying factory's admin — must authorise this.

The pause is time-boxed: it stops blocking after
`MAX_PAUSE_DURATION_SECONDS` (24 hours), so a protocol pause can never
hold an arena — or the funds in it — shut indefinitely. `pause_expired`
reports whether that has happened.

Independent of the factory-wide pause (#1583): unpausing here does not
lift a protocol-wide pause, which surfaces as `ArenaError::GloballyPaused`.

#### Parameters
- `reason`: Short symbol describing why the contract is being paused
  (e.g., `"emerg"`, `"maint"`). Included in the emitted event for
  indexers and dashboards.

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
  protocol admin.

#### Events
Emits `paused` with the protocol admin address and reason symbol.

### pub fn `unpause` — line 1529

Resume normal operation after a `pause`.

Clears the paused flag so all gameplay entry points become callable
again. Only the protocol admin can unpause (#1629).

#### Errors
- `ArenaError::NotInitialized` if `initialize` has not been called.
- `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
  protocol admin.

#### Events
Emits `unpaused` with the protocol admin address.

### pub fn `force_cancel_arena` — line 1545

Force-cancel the arena (protocol admin only, #1629).
Can be called at any state except Finished or Settled.

Allowed while this arena is locally paused, but not while the
protocol-wide pause is set (#1583): cancelling drains the yield vault,
which an incident response may need to keep untouched.

### pub fn `claim_refund` — line 1585

Claim a refund when the arena has been cancelled.

### pub fn `retry_withdraw` — line 1639

Retry the vault withdrawal that failed during a cancellation, expiry, or
settlement (#1631). Permissionless, because recovering the principal
benefits every player and cannot move funds to a new destination.

Idempotent: when no withdrawal is pending it succeeds without touching
the vault. Refunds stay blocked (`FundsInVault`) until a retry succeeds.

#### Errors
- `ArenaError::ContractPaused` / `ArenaError::GloballyPaused` while paused.
- `ArenaError::InvalidGameState` if the arena is not `Cancelled`.
- `ArenaError::VaultWithdrawFailed` if the vault still refuses to release.

### pub fn `funds_in_vault` — line 1661

Whether the principal is still held by the yield vault because a
settlement-time withdrawal failed (#1631). `true` blocks refunds until
`retry_withdraw` succeeds.

### pub fn `get_leaderboard` — line 1666

Get the sorted top-N leaderboard of players.

### pub fn `configure_leaderboard_limit` — line 1675

Configure the leaderboard size limit (admin only).

#### Errors
- `ArenaError::InvalidLeaderboardLimit` if `limit` is 0 or exceeds
  `types::MAX_LEADERBOARD_LIMIT`. Nothing is persisted in that case.

### pub fn `update_platform_fee` — line 1706

Update this arena instance's stored platform fee (0-1000 bps, max 10%).

Protocol-only (#1629): the host of the arena cannot change the fee.
The protocol admin — the deploying factory's admin — must authorise
this.

Each arena is deployed as its own contract instance (one per pool, via
the factory), so this only affects `get_platform_fee_bps` reads on
*this* instance going forward — it does not retroactively change this
arena's own `config.platform_fee_bps` (already snapshotted at
`initialize`), and has no effect on other arena instances, which each
have independent storage. A fee that should apply uniformly to every
newly-deployed arena would need to be threaded through the `factory`
contract's deploy call instead. This value is also not currently
deducted anywhere in `claim`'s payout calculation; it is stored and
exposed for a future payout integration.

#### Errors
- `ArenaError::InvalidPlatformFee` if `new_fee_bps` exceeds
  `MAX_PLATFORM_FEE_BPS`.
- `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
  protocol admin.

### pub fn `get_platform_fee_bps` — line 1720

Return the current global platform fee in basis points.

### pub fn `set_oracle_freshness_policy` — line 1743

Configure this arena instance's oracle freshness policy (#1512).

Protocol-only (#1629): the host of the arena cannot change the oracle
policy. The protocol admin — the deploying factory's admin — must
authorise this.

`max_age_secs`: an oracle observation older than this makes
`resolve_round` refuse with `ArenaError::StaleOracleData`.
`warn_age_secs`: an observation older than this (but younger than
`max_age_secs`) still resolves, but is surfaced via
`oracle_freshness_observed` as `Warning` for alerting.

Like `update_platform_fee`, this only affects *this* arena instance
going forward — each arena has independent storage.

#### Errors
- `ArenaError::InvalidFreshnessPolicy` if the policy is out of range.
- `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
  protocol admin.

### pub fn `get_oracle_freshness_policy` — line 1769

Return this arena instance's current oracle freshness policy (#1512).

### pub fn `get_oracle_contract` — line 1778

Return the oracle contract this arena instance reads its yield rate
from (#1512). Previously only stored inside `ArenaConfig` with no
dedicated getter — an off-chain reader (the backend's own
independent freshness check, or any other tooling) had no way to
discover which oracle instance a given arena actually uses.

### pub fn `get_total_yield` — line 1788

Return the cumulative yield earned across all resolved rounds.

Summed from vault balance deltas recorded during each `resolve_round`
call. Returns `0` if the contract has not been initialised or no rounds
have been resolved.

### pub fn `get_yield_snapshot` — line 1804

Return the yield snapshot recorded when `round` was resolved.

Returns `None` if `round` has not been resolved or does not exist.

#### Parameters
- `round`: 1-based round number (the first round resolved is round 1).

### pub fn `get_round_result` — line 1816

Return the resolution result recorded when `round` was resolved.

Includes eliminated and survivor counts and the associated yield
snapshot. Returns `None` if `round` has not been resolved or does not
exist.

#### Parameters
- `round`: 1-based round number.

## `contract/arena/src/oracle.rs`

### pub trait `OracleInterface` — line 11

Minimal cross-contract client for the yield-rate oracle.
Defined locally to avoid linking the oracle crate implementation into
the arena WASM (which would create duplicate symbol conflicts).

### fn `get_oracle_reading` — line 18

Additive (#1512): mirrors `contract/oracle/src/lib.rs`'s
`OracleReading` field-for-field. A pre-#1512 oracle deployment has no
such entrypoint — `fetch_oracle_reading` treats that call failure as
"no freshness metadata available," not as a hard error (mixed
deployment version compatibility).

### pub fn `as_code` — line 61

Stable numeric code for event payloads (Soroban events favor small
primitives over enums for indexer-friendliness).

### pub fn `classify_freshness` — line 83

Classify an oracle reading's age against a freshness policy.

`reading = None` (oracle unreachable, or a pre-#1512 deployment with no
`get_oracle_reading`) classifies as `Unavailable`, never `Stale` — those
are deliberately distinct outcomes (see `OracleFreshness::Unavailable`'s
doc comment) so a caller can choose different handling for "can't tell"
versus "know it's too old."

A reading whose `observed_at` is in the future relative to `now` (clock/
ledger divergence) is treated as `Stale`, not `Fresh` — a future
timestamp is evidence the observation cannot be trusted, the same
conclusion as one that is too old, so it must not silently pass as fresh.

### pub fn `fetch_oracle_reading` — line 114

Fetch the oracle's rate + observation metadata (#1512).

Returns `None` on any failure layer — unreachable contract, host error,
or an oracle deployment that predates `get_oracle_reading` — never
panics. Callers must not conflate `None` with a real `Stale` reading;
`classify_freshness` keeps them as separate outcomes.

### pub trait `OracleScheduleInterface` — line 144

Schedule-reading client for keepers and frontends (#1570).
Kept separate from [`OracleInterface`] so existing callers and mocks
that only implement `get_current_yield_bps` keep compiling.

### pub fn `fetch_yield_bps` — line 169

Fetch the current yield rate in basis points from the on-chain oracle.

Calls `get_current_yield_bps` on the configured oracle contract and returns
the rate. Returns `0` if the oracle call fails for any reason — liveness
over precision. A 0-bps round uses only the principal, which is correct.

On failure a `vault_oracle_failed` event is emitted with the oracle address
so operators can detect a misconfigured, unreachable, or malfunctioning
oracle instead of silently recording 0 yield.

The oracle contract is an admin-settable rate contract with bounded,
delayed updates (see `contract/oracle/`): `set_yield_bps` schedules (or,
when `activation_delay == 0`, applies) a rate bounded by `max_delta_bps`,
and `get_current_yield_bps` returns the currently effective rate. Arena
resolution snapshots this effective rate once per round, so consumers never
need to track pending values themselves. Future upgrades can swap in an
autonomous feed such as Band Protocol on Stellar or Ondo's own
exchange-rate contract.

Pending schedules and bounds are observable via [`fetch_rate_schedule`]
so keepers and frontends can react before activation.

### pub fn `fetch_rate_schedule` — line 193

Fetch the oracle's full rate schedule (#1570).

Returns `None` when the oracle is unreachable or is an older deployment
without `get_rate_schedule` — the effective rate from
[`fetch_yield_bps`] remains the source of truth for resolution.
Keepers and frontends use this to surface pending rates, activation
times, and bounds (`max_delta_bps`, `activation_delay`) before they
take effect.

## `contract/arena/src/rwa_client.rs`

### pub trait `RwaAdapterInterface` — line 11

Minimal cross-contract client interface for the RWA adapter vault.

Defined locally so the arena WASM does not link the full rwa-adapter
implementation (which would cause duplicate `initialize` symbol conflicts
when linking). The SDK generates `RwaAdapterClient` and the corresponding
`try_*` variants from this trait.

### fn `withdraw` — line 14

Partial withdrawal of `amount`, returning what was actually paid (#1580).

## `contract/arena/src/settlement_security_tests.rs`

### pub fn `balance_of` — line 32

Reports a live deposit so the arena attempts a withdrawal at settlement.

## `contract/arena/src/state_machine.rs`

### pub fn `can_transition` — line 25

Returns `true` if a direct transition from `from` to `to` is allowed.

Kept in sync with the `config.state = …` assignments in `lib.rs`; see the
module-level table above.

### pub fn `ensure_state` — line 40

Guard requiring the arena to currently be in `expected`, returning `err`
otherwise. Used by entry points that are only valid in a single state.

### pub fn `ensure_transition` — line 54

Guard requiring a `from → to` transition to be legal before it is applied.

### pub fn `phase` — line 70

Derive the player-facing phase (#1582). `Open` is the lobby until the first
round resolves and an intermission afterwards; `Active` accepts commitments
strictly before `commit_deadline` and reveals from then on, matching the
guards in `submit_commitment` and `reveal_choice`.

## `contract/arena/src/storage.rs`

### pub fn `load_all_players` — line 661

Return the list of all player addresses that have joined this arena.

### pub fn `load_player_page` — line 678

Return up to `count` player addresses starting at index `start`.

Versioned arenas read one page entry. Legacy arenas use a read-only
fallback until the next state-changing entry point migrates the roster.

### pub fn `remove_player` — line 786

Remove a player who joined but has not yet played, keeping the paged
roster, the survivor index, and both counters consistent (#1580, #1581).

Returns `false` when the address was not on the roster, so callers can
distinguish "removed" from "never joined". Pages are rewritten in place
(roster order is preserved minus the removed address); the `PlayerState`
entry is deleted so a subsequent `join_arena` is treated as a fresh join.

### pub fn `load_player` — line 866

Load a single player's state, or `None` if they never joined.

### pub fn `save_start_deadline` — line 920

Lobby start deadline (#1579), or `0` when none is configured.

### pub fn `save_paused_at` — line 940

Ledger timestamp at which the protocol admin paused this arena (#1629).

`None` means the arena was never paused by the protocol — including
the case of a pause recorded before the role split, which carries no
timestamp and is therefore treated as already expired.

### pub fn `load_commitment` — line 984

Returns the commitment hash for `(player, round)`, or `None` when:
  - the player never committed, OR
  - the temporary entry expired (treated as no-commit per #1612 spec).

Resolution callers should treat `None` as an absent / late commitment
and score the player as having not participated.

### pub fn `remove_player_choice` — line 1011

Remove a single player's choice for a round (#1075: clear stale choice on elimination).
No-op when the entry has already expired or was never written.

### pub fn `prize_claimed` — line 1095

Returns true once the prize has been claimed for this arena. Read inside
`claim` so a reentrant call sees the flag and bails out with
`PrizeAlreadyClaimed` before the token transfer can run a second time.

### pub fn `mark_prize_claimed` — line 1106

Persist the prize-claimed flag. MUST be called before any external
(cross-contract) call in `claim` so that a malicious token contract
re-entering the arena cannot replay the claim.

### pub fn `load_funds_in_vault` — line 1115

Whether a settlement-time vault withdrawal failed and the principal is
still parked in the vault (#1631). Refunds are blocked while this is set.

### pub fn `save_funds_in_vault` — line 1124

Persist the funds-in-vault flag (#1631).

### pub fn `reentrancy_guard_entered` — line 1132

Return whether a state-changing entry point is already executing.

### pub fn `enter_reentrancy_guard` — line 1141

Set the temporary reentrancy guard before state-changing logic performs
any checks/effects/interactions.

### pub fn `exit_reentrancy_guard` — line 1153

Clear the temporary reentrancy guard after a guarded entry point exits.

### pub fn `save_sponsor` — line 1207

Record the payer who funded a sponsored entry (#1715).

### pub fn `remove_sponsor` — line 1214

Remove the sponsor record when a player leaves the lobby (#1715).

### pub fn `refund_recipient` — line 1223

Who receives an entry-fee refund for `player` (#1715). Sponsored
entries return the fee to the payer who funded it; self-funded entries
return it to the player.

### pub fn `load_platform_fee_bps` — line 1260

Global platform fee in basis points. Defaults to 1000 (10%) until the
admin calls `update_platform_fee`. New arenas snapshot this value into
their `ArenaConfig.platform_fee_bps` at `initialize` time.

### pub fn `load_oracle_freshness_policy` — line 1279

Per-instance oracle freshness policy (#1512). Defaults to
`OracleFreshnessPolicy::default_policy()` until the admin calls
`set_oracle_freshness_policy` — mirrors `load_platform_fee_bps`'s
read-with-default pattern above.

### pub fn `peek_sponsor` — line 1364

Read-only sponsor lookup used by `get_player_status` (#1715).

### pub fn `clear_round_data` — line 1379

Clear all players' choices and commitments for the specified round.
Since commitments and choices now live in temporary storage (#1612),
explicit removal is optional — entries will expire on their own TTL.
This helper is retained for callers that want to release storage
immediately (e.g. after resolution) rather than waiting for expiry.

### pub fn `clear_resolution` — line 1440

Drop all paged-resolution state. Called by `finalize_resolution` once
the round is committed, and when a fresh resolution is created.

## `contract/arena/src/timelock.rs`

### pub fn `is_timelock_elapsed` — line 9

Validates if a proposed timelocked upgrade can be executed.

### pub fn `execution_timestamp` — line 14

Computes the execution timestamp for a proposed WASM hash upgrade.

## `contract/arena/src/types.rs`

### pub fn `validate_leaderboard_limit` — line 16

Validate a requested leaderboard size before persisting it.

### pub fn `validate_freshness_policy` — line 69

Validate a freshness policy before persisting it (startup/reconfiguration
validation, per #1512's acceptance criteria).

### pub fn `to_byte` — line 110

Returns the canonical byte representation used in the commitment hash.
