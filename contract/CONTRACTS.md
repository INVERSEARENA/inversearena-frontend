# Smart Contracts API Documentation

## Arena

### Errors
- `which panics rather than returning a Rust error.
    Unauthorized`
- `or when the admin attempts to resolve a round
    /// when the arena is not in the `Active` state.
    RoundNotActive`
- `but they have not submitted a
    /// commitment for the current round.
    MissingCommitment`
- `but they have already successfully
    /// revealed their choice for the current round.
    ChoiceAlreadyRevealed`
- `but the arena is not in the `Finished` state.
    GameNotFinished`
- `or when a payout
    /// has already been executed for this game.
    PrizeAlreadyClaimed`
- `but there is no pending admin
    /// transfer proposal recorded.
    NoPendingAdmin`
- `but they have already claimed it.
    RefundAlreadyClaimed`
- `but the arena is not in the Cancelled state.
    ArenaNotCancelled`
- `but they are not registered.
    NotAPlayer`

### Functions
- `pub fn version(_env: Env) -> u32`
- `pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ArenaError>`
- `pub fn ban_player(env: Env, player: Address) -> Result<(), ArenaError>`
- `pub fn unban_player(env: Env, player: Address) -> Result<(), ArenaError>`
- `pub fn is_player_banned(env: Env, player: Address) -> bool`
- `pub fn join_arena(env: Env, player: Address) -> Result<(), ArenaError>`
- `pub fn cancel_arena(env: Env) -> Result<(), ArenaError>`
- `pub fn get_players(env: Env, page: u32) -> Vec<(Address, PlayerState)>`
- `pub fn player_count(env: Env) -> u32`
- `pub fn get_player_status(env: Env, player: Address) -> Result<PlayerStatus, ArenaError>` — every per-player fact for the current round in one read; `joined: false` for non-players (#1582)
- `pub fn get_settlement(env: Env) -> Result<Settlement, ArenaError>` — what the arena owes and to whom, for the payout contract (#1632)
- `pub fn get_pool_config(env: Env) -> Result<PoolConfigView, ArenaError>` — full canonical pool config (`stake_token`, `yield_vault`, `entry_fee`, `oracle_contract`, `min_players`, `max_players`, `round_duration`, `start_deadline`) so off-chain rematch prefills read on-chain state instead of cached UI state; `round_duration`/`start_deadline` are `0` until the first round starts (#1572)
- `pub fn start_round(env: Env, duration_seconds: u64) -> Result<(), ArenaError>`
- `pub fn start_next_round(env: Env, caller: Address) -> Result<(), ArenaError>`
- `pub fn resolve_round(env: Env) -> Result<(), ArenaError>`
- `pub fn claim(env: Env, winner: Address) -> Result<(), ArenaError>`
- `pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), ArenaError>`
- `pub fn accept_admin(env: Env) -> Result<(), ArenaError>`
- `pub fn change_admin(env: Env, new_admin: Address) -> Result<(), ArenaError>`
- `pub fn pause(env: Env, reason: Symbol) -> Result<(), ArenaError>`
- `pub fn unpause(env: Env) -> Result<(), ArenaError>`
- `pub fn force_cancel_arena(env: Env) -> Result<(), ArenaError>`
- `pub fn claim_refund(env: Env, player: Address) -> Result<(), ArenaError>`
- `pub fn get_leaderboard(env: Env) -> Vec<LeaderboardEntry>`
- `pub fn configure_leaderboard_limit(env: Env, limit: u32) -> Result<(), ArenaError>`
- `pub fn get_total_yield(env: Env) -> i128`
- `pub fn get_yield_snapshot(env: Env, round: u32) -> Option<YieldSnapshot>`
- `pub fn get_round_result(env: Env, round: u32) -> Option<RoundResult>`
- `pub fn get_current_yield_bps(_env: Env) -> u32`
- `pub fn balance_of(env: Env, _user: Address) -> i128`
- `pub fn deposit(_env: Env, _from: Address, _amount: i128)`
- `pub fn withdraw_all(env: Env, user: Address) -> i128`

## Factory

### Storage Keys
- `CreatorStake(Address)`
- `Admin`
- `MinStake`
- `ArenaWasmHash`
- `PoolSequence`
- `Whitelisted(Address)`
- `ApprovedVault(Address)`
- `ApprovedOracle(Address)`

### Errors
- `NotInitialized`
- `AlreadyInitialized`
- `Unauthorized`
- `InvalidStakeAmount`
- `InsufficientCreatorStake`
- `ArenaNotFound`
- `StakeBelowMinimum`
- `HostNotWhitelisted`
- `WasmHashNotSet`
- `PoolLimitReached`
- `InvalidVault`
- `InvalidOracle`

### Functions
- `pub fn initialize(env: Env, admin: Address, min_stake: i128) -> Result<(), FactoryError>`
- `pub fn set_arena_wasm_hash(env: Env, wasm_hash: BytesN<32>) -> Result<(), FactoryError>`
- `pub fn add_to_whitelist(env: Env, host: Address) -> Result<(), FactoryError>`
- `pub fn remove_from_whitelist(env: Env, host: Address) -> Result<(), FactoryError>`
- `pub fn is_whitelisted(env: Env, host: Address) -> bool`
- `pub fn add_approved_vault(env: Env, vault: Address) -> Result<(), FactoryError>`
- `pub fn remove_approved_vault(env: Env, vault: Address) -> Result<(), FactoryError>`
- `pub fn add_approved_oracle(env: Env, oracle: Address) -> Result<(), FactoryError>`
- `pub fn remove_approved_oracle(env: Env, oracle: Address) -> Result<(), FactoryError>`
- `pub fn get_min_stake(env: Env) -> Result<i128, FactoryError>`
- `pub fn get_creator_stake(env: Env, arena: Address) -> Option<CreatorStakeRecord>`
- `pub fn set_global_pause(env: Env, paused: bool, reason: Symbol) -> Result<(), FactoryError>` — protocol-admin emergency pause honoured by every arena's fund-moving entry points (#1583)
- `pub fn is_globally_paused(env: Env) -> bool` (#1583)
- `pub fn get_active_pool_count(env: Env, host: Address) -> u32` — how many Active pools `host` currently has, for rematch `max_active_pools` headroom checks (#1572)

## Payout

### Errors

### Functions
- `pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), PayoutError>`
- `pub fn is_paid(env: Env, payout_id: u64) -> bool`
- `pub fn admin(env: Env) -> Option<Address>`
- `pub fn token(env: Env) -> Option<Address>`

## Rwa-adapter

### Errors
- `NotInitialized`
- `AlreadyInitialized`
- `NoDeposit`
- `Unauthorized`
- `AlreadyWithdrawn`
- `InsufficientBalance`
- `ArithmeticOverflow`
- `InvalidAmount`

### Functions
- `pub fn initialize(env: Env, admin: Address, stake_token: Address) -> Result<(), RwaError>`
- `pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), RwaError>`
- `pub fn withdraw_all(env: Env, from: Address) -> Result<i128, RwaError>`
- `pub fn balance_of(env: Env, user: Address) -> i128`
- `pub fn get_total_deposited(env: Env) -> i128`
- `pub fn upgrade(env: Env, new_wasm_hash: soroban_sdk::BytesN<32>) -> Result<(), RwaError>`

## Oracle

Rate changes are bounded and delayed (#1570): each update may move the rate
by at most `max_delta_bps` and takes effect after `activation_delay` as a
scheduled rate (`pending_rate`, `effective_at`). Every change is evented;
consumers read the effective rate via `get_current_yield_bps` (arena
`resolve_round` snapshots it once per round) and the full schedule via
`get_rate_schedule` for keepers/frontends.

### Functions
- `pub fn initialize(env: Env, admin: Address, initial_rate_bps: u32)`
- `pub fn set_yield_bps(env: Env, rate_bps: u32)` — schedules (or applies immediately when `activation_delay == 0`) a rate bounded by `max_delta_bps` against the effective rate; last pending update wins
- `pub fn set_rate_to_zero(env: Env)` — emergency path: zeroes the rate immediately, bypassing delta bound and delay, clearing any pending update
- `pub fn set_max_delta_bps(env: Env, max_delta_bps: u32)` — per-update bound, itself subject to the activation delay
- `pub fn set_activation_delay(env: Env, delay_secs: u64)` — activation delay within the 7-day hard bound, itself subject to the current delay
- `pub fn set_max_rate(env: Env, max_rate_bps: u32)`
- `pub fn get_current_yield_bps(env: Env) -> u32` — effective rate at the current ledger time
- `pub fn get_oracle_reading(env: Env) -> OracleReading` — `{rate_bps, observed_at, source_version}` (#1512): the effective rate plus when it was applied; `observed_at == 0` means no observation has ever been recorded
- `pub fn get_rate_schedule(env: Env) -> RateSchedule` — `{current, pending, effective_at, max_delta_bps, activation_delay, pending_*, params_effective_at}`
- `pub fn get_max_yield_bps / get_max_delta_bps / get_activation_delay` — effective bound views

### Multi-reporter median (#1578)

The admin maintains a reporter set (up to `MAX_REPORTERS = 8`). Each
reporter submits a rate; once `quorum` fresh submissions (no older than
`max_age_secs`) are present the outlier-filtered median is finalized
on-chain as the effective rate. `get_current_yield_bps` returns the live
median when quorum is met and the last finalized value otherwise — its
signature is unchanged. `get_oracle_status` exposes the staleness flag and
report counts for consumers that need the distinction. A finalized median
supersedes any pending scheduled admin rate and bypasses the
`max_delta_bps` bound (reporters are independent sources); the ceiling
(`max_rate`) still applies to submissions. Consumer policy when quorum is
lost: treat the frozen rate like a stale reading (`stale == true`).

### Functions
- `pub fn add_reporter(env: Env, reporter: Address)` — admin-managed set, rejects duplicates and overflow past `MAX_REPORTERS`
- `pub fn remove_reporter(env: Env, reporter: Address)` — also drops the reporter's outstanding submission (rotation-safe)
- `pub fn set_quorum(env: Env, quorum: u32)` — `1..=MAX_REPORTERS`; may exceed the current reporter count (oracle stays stale until filled)
- `pub fn set_max_age_secs(env: Env, max_age_secs: u64)` — freshness window for submissions
- `pub fn set_max_deviation_bps(env: Env, max_deviation_bps: u32)` — outlier band around the pre-filter median; `0` disables rejection
- `pub fn submit_rate(env: Env, reporter: Address, rate_bps: u32)` — reporter-signed; stores the submission (replacing any prior vote), finalizes the median when quorum is reached
- `pub fn get_reporters(env: Env) -> Vec<Address>` — registered reporters in insertion order
- `pub fn get_oracle_status(env: Env) -> OracleStatus` — `{rate_bps, stale, fresh_reports, quorum, reporter_count, finalized_at}`

## Staking

### Errors
- `NotInitialized`
- `AlreadyInitialized`
- `Paused`
- `InvalidAmount`
- `InsufficientShares`
- `ZeroShares`

### Functions
- `pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), StakingError>`
- `pub fn admin(env: Env) -> Address`
- `pub fn token(env: Env) -> Address`
- `pub fn stake(env: Env, staker: Address, amount: i128) -> Result<i128, StakingError>`
- `pub fn unstake(env: Env, staker: Address, shares: i128) -> Result<i128, StakingError>`
- `pub fn total_staked(env: Env) -> i128`
- `pub fn total_shares(env: Env) -> i128`
- `pub fn get_position(env: Env, staker: Address) -> StakePosition`
- `pub fn staked_balance(env: Env, staker: Address) -> i128`
- `pub fn get_staker_stats(env: Env, staker: Address) -> StakerStats`
- `pub fn pause(env: Env) -> Result<(), StakingError>`
- `pub fn unpause(env: Env) -> Result<(), StakingError>`
- `pub fn is_paused(env: Env) -> bool`

