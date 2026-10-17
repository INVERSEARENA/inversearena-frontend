# Smart Contracts API Documentation

## Arena

### Errors
- `Unauthorized = 1`
- `CannotCancelStartedGame = 2`
- `NotInitialised = 3`
- `RoundNotActive = 4`
- `RoundNotStarted = 5`
- `GracePeriodNotElapsed = 6`
- `InvalidReveal = 7`
- `MissingCommitment = 8`
- `ChoiceAlreadyRevealed = 9`
- `AlreadyInitialized = 10`
- `GameNotFinished = 11`
- `PrizeAlreadyClaimed = 12`
- `PlayerEliminated = 13`
- `NoPendingAdmin = 14`
- `InvalidVaultAddress = 15`
- `ContractPaused = 16`
- `InvalidGameState = 17`
- `NotInitialized = 18`
- `NotEnoughPlayers = 19`
- `PlayerBanned = 20`
- `CreatorCannotJoin = 21`
- `ArenaFull = 22`
- `InvalidPlayerLimits = 23`
- `ReentrantCall = 24`
- `RefundAlreadyClaimed = 25`
- `ArenaNotCancelled = 26`
- `NotAPlayer = 27`
- `DeadlineTooSoon = 28`
- `AlreadyJoined = 29`
- `UpgradeTimelockPending = 30`
- `NoPendingUpgrade = 31`
- `InvalidEntryFee = 32`
- `CommitPhaseEnded = 33`
- `InvalidDuration = 34`
- `VaultDepositFailed = 35`
- `InvalidPlatformFee = 36`
- `ArenaAlreadyStarted = 37`
- `InvalidLeaderboardLimit = 38`
- `InvalidFreshnessPolicy = 39`
- `StaleOracleData = 40`

### Functions
- `pub fn version(_env: Env) -> u32`
- `pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ArenaError>`
- `pub fn execute_upgrade(env: Env) -> Result<(), ArenaError>`
- `pub fn ban_player(env: Env, player: Address) -> Result<(), ArenaError>`
- `pub fn unban_player(env: Env, player: Address) -> Result<(), ArenaError>`
- `pub fn is_player_banned(env: Env, player: Address) -> bool`
- `pub fn join_arena(env: Env, player: Address) -> Result<(), ArenaError>`
- `pub fn cancel_arena(env: Env) -> Result<(), ArenaError>`
- `pub fn expire_arena(env: Env) -> Result<(), ArenaError>`
- `pub fn get_players(env: Env, page: u32) -> Vec<(Address, PlayerState)>`
- `pub fn player_count(env: Env) -> u32`
- `pub fn start_round(env: Env, duration_seconds: u64) -> Result<(), ArenaError>`
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
- `pub fn update_platform_fee(env: Env, new_fee_bps: u32) -> Result<(), ArenaError>`
- `pub fn get_platform_fee_bps(env: Env) -> u32`
- `pub fn get_oracle_freshness_policy(env: Env) -> OracleFreshnessPolicy`
- `pub fn get_oracle_contract(env: Env) -> Result<Address, ArenaError>`
- `pub fn get_total_yield(env: Env) -> i128`
- `pub fn get_yield_snapshot(env: Env, round: u32) -> Option<YieldSnapshot>`
- `pub fn get_round_result(env: Env, round: u32) -> Option<RoundResult>`
- `pub fn get_current_yield_bps(_env: Env) -> u32`
- `pub fn set_reading(env: Env, rate_bps: u32, observed_at: u64, source_version: u32)`
- `pub fn get_current_yield_bps(env: Env) -> u32`
- `pub fn get_oracle_reading(env: Env) -> oracle::OracleReading`
- `pub fn balance_of(env: Env, _user: Address) -> i128`
- `pub fn deposit(_env: Env, _from: Address, _amount: i128)`
- `pub fn withdraw_all(env: Env, user: Address) -> i128`

## Factory

### Storage Keys
- `CreatorStake(Address)`
- `Admin`
- `PendingAdmin`
- `MinStake`
- `ArenaWasmHash`
- `PoolSequence`
- `Whitelisted(Address)`
- `ApprovedVault(Address)`
- `ApprovedOracle(Address)`
- `ActivePoolCount(Address)`
- `MaxActivePools`
- `PoolCount`
- `Pool(u32)`
- `Paused`
- `SupportedToken(Address)`

### Errors
- `NotInitialized = 1`
- `AlreadyInitialized = 2`
- `Unauthorized = 3`
- `InvalidStakeAmount = 4`
- `InsufficientCreatorStake = 5`
- `ArenaNotFound = 6`
- `StakeBelowMinimum = 7`
- `HostNotWhitelisted = 8`
- `WasmHashNotSet = 9`
- `PoolLimitReached = 10`
- `InvalidVault = 11`
- `InvalidOracle = 12`
- `MaxActivePoolsReached = 13`
- `PoolNotFound = 14`
- `ContractPaused = 15`
- `UnsupportedToken = 16`
- `EntryFeeTooLow = 17`
- `InvalidConfig = 18`
- `NoPendingAdmin = 19`
- `ArithmeticOverflow = 20`

### Functions
- `pub fn initialize(env: Env, admin: Address, min_stake: i128) -> Result<(), FactoryError>`
- `pub fn version(_env: Env) -> u32`
- `pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), FactoryError>`
- `pub fn set_arena_wasm_hash(env: Env, wasm_hash: BytesN<32>) -> Result<(), FactoryError>`
- `pub fn add_to_whitelist(env: Env, host: Address) -> Result<(), FactoryError>`
- `pub fn remove_from_whitelist(env: Env, host: Address) -> Result<(), FactoryError>`
- `pub fn is_whitelisted(env: Env, host: Address) -> bool`
- `pub fn add_approved_vault(env: Env, vault: Address) -> Result<(), FactoryError>`
- `pub fn remove_approved_vault(env: Env, vault: Address) -> Result<(), FactoryError>`
- `pub fn add_approved_oracle(env: Env, oracle: Address) -> Result<(), FactoryError>`
- `pub fn remove_approved_oracle(env: Env, oracle: Address) -> Result<(), FactoryError>`
- `pub fn is_approved_vault(env: Env, vault: Address) -> bool`
- `pub fn is_approved_oracle(env: Env, oracle: Address) -> bool`
- `pub fn add_supported_token(env: Env, token: Address) -> Result<(), FactoryError>`
- `pub fn remove_supported_token(env: Env, token: Address) -> Result<(), FactoryError>`
- `pub fn is_token_supported(env: Env, token: Address) -> bool`
- `pub fn get_min_stake(env: Env) -> Result<i128, FactoryError>`
- `pub fn set_max_active_pools(env: Env, max: u32) -> Result<(), FactoryError>`
- `pub fn get_max_active_pools(env: Env) -> u32`
- `pub fn pause(env: Env) -> Result<(), FactoryError>`
- `pub fn unpause(env: Env) -> Result<(), FactoryError>`
- `pub fn release_arena(env: Env, arena: Address) -> Result<(), FactoryError>`
- `pub fn get_creator_stake(env: Env, arena: Address) -> Option<CreatorStakeRecord>`
- `pub fn reclaim_creator_stake(env: Env, arena: Address) -> Result<(), FactoryError>`
- `pub fn get_arena(env: Env, pool_id: u32) -> Option<ArenaMetadata>`
- `pub fn get_arenas(env: Env, offset: u32, limit: u32) -> Vec<ArenaMetadata>`
- `pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), FactoryError>`
- `pub fn accept_admin(env: Env) -> Result<(), FactoryError>`

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


## Staking

### Errors
- `NotInitialized = 1`
- `AlreadyInitialized = 2`
- `Paused = 3`
- `InvalidAmount = 4`
- `InsufficientShares = 5`
- `ZeroShares = 6`
- `BelowMinimumInitialStake = 7`
- `NoSharesOutstanding = 8`
- `NoPendingAdmin = 9`
- `ArithmeticOverflow = 10`

### Functions
- `pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), StakingError>`
- `pub fn version(_env: Env) -> u32`
- `pub fn admin(env: Env) -> Address`
- `pub fn token(env: Env) -> Address`
- `pub fn pause(env: Env) -> Result<(), StakingError>`
- `pub fn unpause(env: Env) -> Result<(), StakingError>`
- `pub fn is_paused(env: Env) -> bool`
- `pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), StakingError>`
- `pub fn accept_admin(env: Env) -> Result<(), StakingError>`
- `pub fn total_staked(env: Env) -> i128`
- `pub fn total_shares(env: Env) -> i128`
- `pub fn get_position(env: Env, staker: Address) -> StakePosition`
- `pub fn staked_balance(env: Env, staker: Address) -> i128`
- `pub fn get_staker_stats(env: Env, staker: Address) -> StakerStats`
- `pub fn stake(env: Env, staker: Address, amount: i128) -> Result<i128, StakingError>`
- `pub fn unstake(env: Env, staker: Address, shares: i128) -> Result<i128, StakingError>`
- `pub fn get_shares(env: Env, staker: Address) -> i128`
- `pub fn min_initial_stake(_env: Env) -> i128`
- `pub fn distribute_rewards(env: Env, caller: Address, amount: i128) -> Result<(), StakingError>`
- `pub fn reward_rate(env: Env) -> i128`
- `pub fn reward_duration(env: Env) -> u64`
- `pub fn set_reward_duration(env: Env, duration: u64) -> Result<(), StakingError>`
- `pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), StakingError>`
- `pub fn storage_inventory(env: Env) -> Vec<StorageKeyInfo>`
- `pub fn renew_storage(env: Env) -> Result<(), StakingError>`

## Payout

### Errors
- `NotInitialised = 1`
- `AlreadyInitialised = 2`
- `Unauthorized = 3`
- `AlreadyPaid = 4`
- `InvalidAmount = 5`
- `EmptyBatch = 6`
- `InsufficientBalance = 8`
- `DuplicateRecipient = 9`
- `BatchTooLarge = 10`
- `NoPendingAdmin = 11`
- `DestinationMismatch = 12`
- `DestinationNotRegistered = 13`

### Functions
- `pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), PayoutError>`
- `pub fn version(_env: Env) -> u32`
- `pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), PayoutError>`
- `pub fn is_paid(env: Env, payout_id: u64) -> bool`
- `pub fn get_destination(env: Env, payout_id: u64) -> Option<Address>`
- `pub fn admin(env: Env) -> Option<Address>`
- `pub fn token(env: Env) -> Option<Address>`
- `pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), PayoutError>`
- `pub fn accept_admin(env: Env) -> Result<(), PayoutError>`
- `pub fn transfer_count(env: Env) -> u32`
- `pub fn reentry_blocked(env: Env) -> bool`
- `pub fn balance(env: Env, _id: Address) -> i128`
- `pub fn transfer(env: Env, _from: Address, _to: Address, _amount: i128)`

## RWA Adapter

### Errors
- `NotInitialized = 1`
- `AlreadyInitialized = 2`
- `NoDeposit = 3`
- `Unauthorized = 4`
- `AlreadyWithdrawn = 5`
- `InsufficientBalance = 6`
- `ArithmeticOverflow = 7`
- `InvalidAmount = 8`
- `NoPendingAdmin = 9`
- `NotAdmin = 10`

### Functions
- `pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), RwaError>`
- `pub fn withdraw_all(env: Env, from: Address) -> Result<i128, RwaError>`
- `pub fn balance_of(env: Env, user: Address) -> i128`
- `pub fn get_total_deposited(env: Env) -> i128`
- `pub fn sync(env: Env) -> Result<(), RwaError>`
- `pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), RwaError>`
- `pub fn accept_admin(env: Env) -> Result<(), RwaError>`
- `pub fn upgrade(env: Env, new_wasm_hash: soroban_sdk::BytesN<32>) -> Result<(), RwaError>`
- `pub fn get_current_yield_bps(_env: Env) -> u32`

## Oracle

### Errors
- `NotInitialized = 1`
- `AlreadyInitialized = 2`
- `RateTooHigh = 3`
- `NoPendingAdmin = 4`

### Functions
- `pub fn initialize(env: Env, admin: Address, initial_rate_bps: u32) -> Result<(), OracleError>`
- `pub fn set_yield_bps(env: Env, rate_bps: u32) -> Result<(), OracleError>`
- `pub fn set_max_rate(env: Env, max_rate_bps: u32) -> Result<(), OracleError>`
- `pub fn get_max_yield_bps(env: Env) -> u32`
- `pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), OracleError>`
- `pub fn accept_admin(env: Env) -> Result<(), OracleError>`
- `pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), OracleError>`
- `pub fn get_current_yield_bps(env: Env) -> u32`
- `pub fn get_oracle_reading(env: Env) -> OracleReading`

