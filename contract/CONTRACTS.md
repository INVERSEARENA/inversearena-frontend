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

### Functions
- `pub fn initialize(env: Env, admin: Address, initial_rate_bps: u32)`
- `pub fn set_yield_bps(env: Env, rate_bps: u32)`
- `pub fn get_current_yield_bps(env: Env) -> u32`

## Staking

